"use strict";

(() => {
  const { WebModel, classify } = globalThis.ClotrTrace;
  const SVG = "http://www.w3.org/2000/svg";

  // ---------- Drawing it ----------

  const STEP_MS = 650; // the card's pace: slow enough to read, quick enough to keep up with the run
  const IDLE_STEP_MS = 2000; // nobody's touched the window for a while (main-window.js's data-idle)
  const HEIGHT = 440;
  const CARD_HEIGHT = 136;
  const LINES = 5;
  const MAX_BEADS = 5;
  const BEAD_ANGLES = [145, 215, 118, 242, 92].map((degrees) => (degrees * Math.PI) / 180);
  const PIN_WIDTH = 180;
  const PIN_GAP = 18;
  const MAX_PINS = 6;
  const DOTS = 3;
  const ROOT_X = 46;
  const ROOT_LABEL_X = 12;

  // ---------- Small builders ----------

  function svgEl(name, attrs = {}) {
    const node = document.createElementNS(SVG, name);
    for (const [attr, value] of Object.entries(attrs)) node.setAttribute(attr, value);
    return node;
  }

  function icon(id, className = "tm-icon") {
    const svg = svgEl("svg", { class: className, "aria-hidden": "true", focusable: "false" });
    svg.append(svgEl("use", { href: `#${id}` }));
    return svg;
  }

  function div(className, text) {
    const node = document.createElement("div");
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function span(className, text) {
    const node = document.createElement("span");
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function brackets() {
    const corners = span("tm-brk");
    for (let i = 0; i < 4; i++) corners.append(document.createElement("i"));
    return corners;
  }

  // A card's made-up lines of text, the same for the same file every time: never the file's real contents.
  function lineWidths(index) {
    let x = (index * 2654435761) >>> 0;
    const out = [];
    for (let i = 0; i < LINES; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      out.push(38 + ((x >>> 8) % 56));
    }
    return out;
  }

  function clipped(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function px(number) {
    return number.toFixed(1);
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  // ---------- The view's parts ----------

  const STATE_WORD = { reading: "ws.tmReading", personal: "ws.tmPersonal", look: "ws.tmLook" };

  const MORE_WORDS = [
    ["personal", "ws.tmMorePersonal"],
    ["unread", "ws.tmMoreUnread"],
    ["clean", "ws.tmMoreClean"],
  ];

  // A card: the file being read, or a kept find.
  function makeCard(pin) {
    const el = div(pin ? "tm-card tm-pin" : "tm-card");
    const glow = span("tm-glow");
    const head = div("tm-ch");
    const stateIcon = icon("i-st-reading");
    const name = document.createElement("b");
    head.append(stateIcon, name);
    const dir = div("tm-dir");
    const body = div("tm-lines");
    const bars = [];
    for (let i = 0; i < LINES; i++) {
      const bar = document.createElement("i");
      bars.push(bar);
      body.append(bar);
    }
    const band = span("tm-band");
    const hl = span("tm-hl");
    const tag = span("tm-tag");
    const clot = icon("mark", "tm-clot");
    body.append(band, hl, tag, clot);
    const foot = div("tm-foot");
    const chip = span("tm-chip");
    const chipIcon = icon("i-st-reading");
    const chipWords = span("");
    chip.append(chipIcon, chipWords);
    foot.append(chip);
    el.append(glow, brackets(), head, dir, body, foot);
    return { el, stateIcon, name, dir, bars, hl, tag, clot, chip, chipIcon, chipWords, key: null, state: null };
  }

  // The parts, built once: the web's SVG layers, the dots, the idle line, the card for the file being read,
  // the kept row and the counted chips, put on `host`. `lookUpWord` is the view's own word lookup.
  function buildWebParts(host, lookUpWord) {
    const board = div("tm-board");
    const web = div("tm-web");
    const svg = svgEl("svg", { class: "tm-web-svg", "aria-hidden": "true" });
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: "tm-wg", gradientUnits: "userSpaceOnUse", x1: "0", y1: "0", y2: "0" });
    grad.append(svgEl("stop", { offset: "0", style: "stop-color: var(--tm-g1)" }));
    grad.append(svgEl("stop", { offset: "1", style: "stop-color: var(--tm-g2)" }));
    defs.append(grad);
    const linkGroup = svgEl("g");
    const leader = svgEl("path", { class: "tm-leader" });
    const nodeGroup = svgEl("g");
    svg.append(defs, linkGroup, leader, nodeGroup);
    const dots = [];
    for (let i = 0; i < DOTS; i++) dots.push(span("tm-dot"));
    const idleNote = div("tm-idle", lookUpWord("ws.tmIdle"));
    web.append(svg, ...dots, idleNote);

    // The card for the file being read: placed with the `translate` property, never `transform`, so its
    // grow-while-reading `scale` can't multiply the distance it's moved by.
    const card = makeCard(false);
    card.el.hidden = true;
    web.append(card.el);

    const keptEl = div("tm-kept");
    const keptHead = div("tm-kept-head", lookUpWord("ws.tmKept"));
    const keptRow = div("tm-kept-row");
    keptEl.append(keptHead, keptRow);
    const tile = div("tm-more-tile");
    tile.hidden = true;
    keptRow.append(tile);
    const more = div("tm-more");
    const moreChips = {};
    for (const key of ["personal", "unread", "clean"]) {
      const chip = span(`tm-chip ${key}`);
      const label = span("");
      chip.append(icon(`i-st-${key}`), label);
      chip.hidden = true;
      moreChips[key] = { chip, label };
      more.append(chip);
    }
    board.append(web, keptEl, more);
    host.replaceChildren(board);
    return {
      web,
      svg,
      grad,
      linkGroup,
      leader,
      nodeGroup,
      dots,
      idleNote,
      card,
      keptEl,
      keptHead,
      keptRow,
      tile,
      moreChips,
    };
  }

  // The root node, "This PC", drawn once in the node layer.
  function makeRootParts(nodeGroup) {
    const group = svgEl("g", { class: "wn d0 root" });
    const dot = svgEl("circle", { class: "wn-dot", r: "9" });
    // Starts just inside the web's left edge: centred on a dot this close to it, a longer name ran off.
    const label = svgEl("text", { class: "wn-label", x: String(ROOT_LABEL_X - ROOT_X), y: "27" });
    const tName = svgEl("tspan", { class: "wn-name" });
    const tCount = svgEl("tspan", { class: "wn-count", dx: "6" });
    label.append(tName, tCount);
    group.append(dot, label);
    nodeGroup.append(group);
    return { g: group, tName, tCount };
  }

  // ---------- The view ----------

  function WebView(host, { t, fmt, folderName, kindOf, crumb }) {
    // ----- Motion and visibility -----
    const page = document.documentElement;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    function still() {
      return page.dataset.motion === "still" || Boolean(reduce?.matches);
    }
    function unseen() {
      return page.dataset.visible === "false";
    }
    function quiet() {
      return still() || page.dataset.idle === "true";
    }

    // ----- The view's state -----
    let model = null;
    let drawn = -1;
    let drawnWidth = 0;
    let geometry = null;
    let lastStep = 0;
    let frame = 0;
    let timer = null;
    let finished = false;
    let lastActive = null;

    // ----- The parts, built once -----
    const webParts = buildWebParts(host, t);
    const { web, svg, grad, linkGroup, leader, nodeGroup, dots } = webParts;
    const { idleNote, card, keptEl, keptHead, keptRow, tile, moreChips } = webParts;

    function where(file) {
      const top = folderName(file.folder);
      const inSubfolder = file.parent && file.parent.toLowerCase() !== String(file.folder).toLowerCase();
      return inSubfolder ? `${top} › ${file.parent}` : top;
    }

    function fill(shownCard, file, state) {
      if (shownCard.key !== file.index) {
        shownCard.key = file.index;
        shownCard.state = null;
        shownCard.name.textContent = file.name;
        shownCard.dir.textContent = where(file);
        lineWidths(file.index).forEach((width, i) => (shownCard.bars[i].style.width = `${width}%`));
      }
      if (shownCard.state === state) return;
      shownCard.state = state;
      shownCard.el.dataset.s = state;
      const id = `i-st-${state}`;
      shownCard.stateIcon.firstChild.setAttribute("href", `#${id}`);
      shownCard.chipIcon.firstChild.setAttribute("href", `#${id}`);
      shownCard.chip.className = `tm-chip ${state}`;
      shownCard.chipWords.textContent = t(STATE_WORD[state]);
      // Where the find sits on the card is made up too (the reader never says which line): one line, picked
      // by the file's index, is where the band settles, with the kind Results would name first.
      const find = state === "look" || state === "personal";
      const hit = (file.index * 7) % LINES;
      shownCard.bars.forEach((bar, i) => (bar.className = find && i === hit ? "hit" : ""));
      shownCard.tag.textContent = find ? kindOf(file.found) : "";
      shownCard.tag.style.top = `${hit * 9 - 6}px`;
      shownCard.hl.style.top = `${hit * 9 - 4}px`;
      shownCard.clot.style.top = `${hit * 9 - 12}px`;
    }

    // ----- Nodes: one SVG group each, made the first time the model has the node, never one per file -----
    const drawnNodes = new Map(); // model node -> its parts

    function nodeParts(folderNode) {
      let parts = drawnNodes.get(folderNode);
      if (parts) return parts;
      const group = svgEl("g", { class: `wn d${folderNode.depth}` });
      const halo = svgEl("circle", { class: "wn-halo", r: "12" });
      const dot = svgEl("circle", { class: "wn-dot", r: "0" });
      const beads = svgEl("g");
      const label = svgEl("text", { class: "wn-label" });
      const tName = svgEl("tspan", { class: "wn-name" });
      const tCount = svgEl("tspan", { class: "wn-count", dx: "6" });
      const tLook = svgEl("tspan", { class: "wn-look", dx: "8" });
      const tPers = svgEl("tspan", { class: "wn-pers", dx: "6" });
      label.append(tName, tCount, tLook, tPers);
      group.append(halo, dot, beads, label);
      nodeGroup.append(group);
      parts = {
        g: group,
        halo,
        dot,
        beads,
        label,
        tName,
        tCount,
        tLook,
        tPers,
        link: null,
        beadN: 0,
        words: "",
        cls: "",
        mode: "",
      };
      parts.link = svgEl("path", { class: "wl", pathLength: "1" });
      linkGroup.append(parts.link);
      // Born where its parent is, so it grows out of it.
      const from = folderNode.parent ? drawnNodes.get(folderNode.parent) : null;
      parts.x = from ? from.x : geometry.rootX;
      parts.y = from ? from.y : HEIGHT / 2;
      parts.r = 0;
      parts.fresh = true;
      drawnNodes.set(folderNode, parts);
      return parts;
    }

    const rootParts = makeRootParts(nodeGroup);

    // ----- A node's numbers, name and size -----
    function looks(folderNode) {
      return folderNode.look + (folderNode.kidLook || 0);
    }

    function pers(folderNode) {
      return folderNode.personal + (folderNode.kidPersonal || 0);
    }

    function nameOf(folderNode) {
      const isTop = folderNode.depth === 1;
      if (!folderNode.more) return isTop ? folderName(folderNode.label) : folderNode.label;
      if (folderNode.merged === 1 && folderNode.lastName) {
        return isTop ? folderName(folderNode.lastName) : folderNode.lastName;
      }
      return t("ws.tmMoreFolders", fmt(folderNode.merged));
    }

    function radius(folderNode) {
      if (folderNode.depth === 1) return 5 + Math.min(10, Math.sqrt(folderNode.all) / 4);
      return 3.5 + Math.min(8, Math.sqrt(folderNode.read) / 3);
    }

    // ----- Layout -----

    // The root on the left, top folders in a column, their subfolders in the next, the card on the right.
    // Rows share the web's height, so a few dozen nodes always fit.
    function layout() {
      const width = web.clientWidth;
      if (!width) return false;
      if (width === drawnWidth && geometry) return true;
      drawnWidth = width;
      const narrow = drawnWidth < 760;
      const cardW = narrow ? 184 : 210;
      const leafX = drawnWidth * (narrow ? 0.4 : 0.46);
      const cardX = drawnWidth - cardW - 22;
      geometry = {
        rootX: ROOT_X,
        topX: Math.max(150, drawnWidth * (narrow ? 0.19 : 0.22)),
        leafX,
        cardW,
        cardX,
        // A subfolder's name, its count and its marks end before the card starts: in a half-screen window a
        // 22-letter name once ran under the card. About 7 px a letter, and about 90 px for the dot, count and
        // marks.
        nameMax: Math.max(10, Math.min(narrow ? 14 : 22, Math.floor((cardX - leafX - 90) / 7))),
      };
      grad.setAttribute("x1", String(geometry.rootX));
      grad.setAttribute("x2", String(geometry.leafX + 60));
      card.el.style.width = `${cardW}px`;
      drawn = -1;
      return true;
    }

    function rows() {
      const list = [];
      for (const top of model.tops) {
        if (top.kids.length) list.push(...top.kids);
        else list.push(top);
      }
      // Rows close up to fit rather than run past the frame's top and bottom, however many folders there are.
      const gap = list.length > 1 ? Math.min(34, (HEIGHT - 64) / (list.length - 1)) : 0;
      const firstY = (HEIGHT - gap * (list.length - 1)) / 2 - 6;
      const at = new Map();
      list.forEach((row, i) =>
        at.set(row, { x: row.depth === 1 ? geometry.topX : geometry.leafX, y: firstY + i * gap }),
      );
      for (const top of model.tops) {
        if (!top.kids.length) continue;
        at.set(top, { x: geometry.topX, y: average(top.kids.map((kid) => at.get(kid).y)) });
      }
      const topYs = model.tops.map((top) => at.get(top).y);
      const rootY = topYs.length ? average(topYs) : HEIGHT / 2;
      return { at, rootY };
    }

    function linkD(a, b) {
      const x1 = a.x + a.r + 1;
      const x2 = b.x - b.r - 1;
      const half = (x2 - x1) / 2;
      return `M${px(x1)} ${px(a.y)} C${px(x1 + half)} ${px(a.y)} ${px(x2 - half)} ${px(b.y)} ${px(x2)} ${px(b.y)}`;
    }

    // ----- Beads and labels -----
    function bead(parts, state, slot) {
      const angle = BEAD_ANGLES[slot];
      const group = svgEl("g", { class: `wbead ${state}` });
      const stub = svgEl("line", { class: "wstub" });
      const mark =
        state === "look"
          ? svgEl("circle", { class: "wsat", r: "4.2" })
          : svgEl("path", { class: "wsat", d: "M0 -4.6 4.4 3.4H-4.4z" });
      group.append(stub, mark);
      parts.beads.append(group);
      return { g: group, stub, mark, a: angle };
    }

    // One bead per find in this folder, worth a look first, up to a handful; the label carries the full
    // count.
    function placeBeads(parts, folderNode) {
      const want = Math.min(MAX_BEADS, folderNode.look + folderNode.personal);
      while (parts.beadN < want) {
        const slot = parts.beadN;
        parts.beadN++;
        (parts.beadList ||= []).push(bead(parts, slot < folderNode.look ? "look" : "personal", slot));
      }
      for (const placed of parts.beadList || []) {
        const inner = parts.r + 1;
        const outer = parts.r + 11;
        const cx = Math.cos(placed.a) * outer;
        const cy = -Math.sin(placed.a) * outer;
        placed.stub.setAttribute("x1", px(Math.cos(placed.a) * inner));
        placed.stub.setAttribute("y1", px(-Math.sin(placed.a) * inner));
        placed.stub.setAttribute("x2", px(cx));
        placed.stub.setAttribute("y2", px(cy));
        placed.mark.setAttribute("transform", `translate(${px(cx)} ${px(cy)})`);
      }
    }

    function words(parts, folderNode) {
      const name = clipped(nameOf(folderNode), geometry.nameMax);
      const lookCount = looks(folderNode);
      const personalCount = pers(folderNode);
      const key = `${name}|${folderNode.all}|${lookCount}|${personalCount}`;
      if (key === parts.words) return;
      parts.words = key;
      parts.tName.textContent = name;
      parts.tCount.textContent = fmt(folderNode.depth === 2 ? folderNode.read : folderNode.all);
      parts.tLook.textContent = lookCount ? `● ${fmt(lookCount)}` : "";
      parts.tPers.textContent = personalCount ? `▲ ${fmt(personalCount)}` : "";
      parts.tPers.setAttribute("dx", lookCount ? "6" : "8");
    }

    function placeLabel(parts, folderNode) {
      const mode = folderNode.depth === 1 && folderNode.kids.length ? "above" : "right";
      if (mode !== parts.mode) {
        parts.mode = mode;
        parts.label.setAttribute("text-anchor", mode === "right" ? "start" : "middle");
      }
      if (mode === "right") {
        parts.label.setAttribute("x", px(parts.r + 8));
        parts.label.setAttribute("y", "4.5");
      } else {
        parts.label.setAttribute("x", "0");
        parts.label.setAttribute("y", px(-parts.r - 9));
      }
    }

    // ----- One step's worth: only what changed since the last one -----

    // A node's classes: its depth, whether the run is in it (and leads there), its colour once done, and
    // marks.
    function nodeClass(folderNode, on, isLead, colour) {
      let className = `wn d${folderNode.depth}`;
      if (on) className += " active";
      if (isLead) className += " lead";
      if (!on && colour) className += ` s-${colour}`;
      if (looks(folderNode)) className += " has-look";
      if (pers(folderNode)) className += " has-pers";
      return className;
    }

    // A new node is drawn once where it's born before it moves, so it grows out of its parent.
    function showNewNodesWhereBorn() {
      let fresh = false;
      for (const folderNode of model.nodes) {
        const parts = nodeParts(folderNode);
        if (parts.fresh) fresh = true;
      }
      if (!fresh || quiet()) return;
      for (const [, parts] of drawnNodes) {
        if (!parts.fresh) continue;
        parts.g.style.transform = `translate(${px(parts.x)}px, ${px(parts.y)}px)`;
      }
      void svg.getBoundingClientRect();
    }

    function drawNode(folderNode, to, rootPos, act, actTop) {
      const parts = drawnNodes.get(folderNode);
      parts.fresh = false;
      parts.x = to.x;
      parts.y = to.y;
      parts.r = radius(folderNode);
      parts.g.style.transform = `translate(${px(parts.x)}px, ${px(parts.y)}px)`;
      parts.dot.style.r = `${px(parts.r)}px`;
      parts.halo.setAttribute("r", px(parts.r + 6));
      const parent = folderNode.depth === 1 ? rootPos : drawnNodes.get(folderNode.parent);
      parts.link.style.d = `path("${linkD(parent, parts)}")`;
      placeLabel(parts, folderNode);
      placeBeads(parts, folderNode);
      words(parts, folderNode);
      const on = !finished && act && (folderNode === act || folderNode === actTop);
      const isLead = folderNode === act && !finished;
      const className = nodeClass(folderNode, on, isLead, model.colour(folderNode));
      if (className === parts.cls) return;
      parts.cls = className;
      parts.g.setAttribute("class", className);
      parts.link.classList.toggle("on", Boolean(on));
    }

    function render() {
      if (!model || !layout()) return;
      const { at, rootY } = rows();
      const rootPos = { x: geometry.rootX, y: rootY, r: 9 };
      rootParts.g.style.transform = `translate(${px(rootPos.x)}px, ${px(rootPos.y)}px)`;
      rootParts.tCount.textContent = model.read ? fmt(model.read) : "";
      const act = model.active;
      let actTop = null;
      if (act) actTop = act.depth === 1 ? act : act.parent;
      showNewNodesWhereBorn();
      for (const folderNode of model.nodes) drawNode(folderNode, at.get(folderNode), rootPos, act, actTop);
      // The line to the folder the run just moved into draws itself in.
      if (act && act !== lastActive && !quiet()) drawLink(drawnNodes.get(act).link);
      lastActive = act;

      drawCard();
      drawKept();
      idleNote.hidden = model.nodes.length > 0;
      drawn = model.version;
    }

    function drawLink(path) {
      path.animate?.([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
        duration: 600,
        easing: "cubic-bezier(0.22, 0.9, 0.26, 1)",
      });
    }

    // ----- The card on the web -----

    // The card beside its folder, the dotted trace between them, and the dots it sends home along it.

    // The trace leaves from the end of the folder's label, so it never crosses its name.
    function drawTrace(parts, folderAt, cardY) {
      const labelEnd = parts && parts.mode === "right" ? 16 + parts.label.getComputedTextLength() : 4;
      const startX = folderAt.x + folderAt.r + labelEnd;
      const endX = geometry.cardX - 6;
      const endY = cardY + CARD_HEIGHT / 2;
      const half = (endX - startX) / 2;
      const ny = folderAt.y;
      const d =
        `M${px(endX)} ${px(endY)} C${px(endX - half)} ${px(endY)} ` +
        `${px(startX + half)} ${px(ny)} ${px(startX)} ${px(ny)}`;
      leader.style.d = `path("${d}")`;
      for (const dot of dots) dot.style.offsetPath = `path("${d}")`;
    }

    function drawCard() {
      const shown = finished ? null : model.card;
      card.el.hidden = !shown;
      leader.style.display = shown ? "" : "none";
      for (const dot of dots) dot.hidden = !shown;
      web.classList.toggle("has-card", Boolean(shown));
      if (crumb) crumb.textContent = shown ? `${where(shown)} › ${shown.name}` : "";
      if (!shown) return;
      const changed = card.key !== shown.index;
      fill(card, shown, shown.state || "reading");
      if (changed && !quiet()) {
        card.el.classList.remove("swap");
        void card.el.offsetWidth;
        card.el.classList.add("swap");
      }
      const folderNode = model.nodeOf(shown);
      const parts = folderNode === model.root ? null : drawnNodes.get(folderNode);
      const folderAt = parts ? { x: parts.x, y: parts.y, r: parts.r } : { x: geometry.rootX, y: HEIGHT / 2, r: 9 };
      const y = Math.max(14, Math.min(HEIGHT - CARD_HEIGHT - 14, folderAt.y - CARD_HEIGHT / 2));
      card.el.style.translate = `${px(geometry.cardX)}px ${px(y)}px`;
      card.el.dataset.x = px(geometry.cardX);
      drawTrace(parts, folderAt, y);
    }

    // ----- Kept finds -----

    // Anything worth a look: one row, as many as fit, then "+N more worth a look in Results"; the rest
    // counted.
    const pins = [];

    function drawKept() {
      const width = keptRow.clientWidth;
      const slots = Math.min(MAX_PINS, Math.max(2, Math.floor((width + PIN_GAP) / (PIN_WIDTH + PIN_GAP))));
      keptRow.style.setProperty("--tm-slots", String(slots));
      const { shown, more: extra } = model.pinRow(slots);
      while (pins.length < shown.length) {
        const pin = makeCard(true);
        keptRow.insertBefore(pin.el, tile);
        pins.push(pin);
      }
      pins.forEach((pin, i) => {
        pin.el.hidden = i >= shown.length;
        if (i < shown.length) fill(pin, shown[i], "look");
      });
      tile.hidden = !extra;
      if (extra) tile.textContent = t("ws.tmMoreLook", fmt(extra));
      keptEl.classList.toggle("has", shown.length > 0);
      const counts = model.counts;
      for (const [key, word] of MORE_WORDS) {
        moreChips[key].chip.hidden = !counts[key];
        if (counts[key]) moreChips[key].label.textContent = t(word, fmt(counts[key]));
      }
    }

    // ----- Pace -----

    // A step at most every STEP_MS, drawn on an animation frame, and nothing at all while the window is
    // hidden (the next file to land after it's back draws it again).
    function tick() {
      frame = 0;
      lastStep = performance.now();
      model?.step();
      if (model && model.version !== drawn) render();
    }

    function kick() {
      if (frame || timer || !model || unseen()) return;
      const pace = page.dataset.idle === "true" ? IDLE_STEP_MS : STEP_MS;
      const wait = lastStep + pace - performance.now();
      if (wait <= 0) {
        frame = requestAnimationFrame(tick);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        frame = requestAnimationFrame(tick);
      }, wait);
    }

    function cancelPace() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = 0;
      timer = null;
    }

    // ----- Clearing -----
    function clear() {
      cancelPace();
      for (const [, parts] of drawnNodes) {
        parts.g.remove();
        parts.link.remove();
      }
      drawnNodes.clear();
      for (const pin of pins) pin.el.remove();
      pins.length = 0;
      tile.hidden = true;
      card.el.hidden = true;
      card.key = null;
      card.state = null;
      leader.style.display = "none";
      for (const dot of dots) dot.hidden = true;
      web.classList.remove("has-card");
      for (const { chip } of Object.values(moreChips)) chip.hidden = true;
      keptEl.classList.remove("has");
      lastActive = null;
      rootParts.tCount.textContent = "";
      if (crumb) crumb.textContent = "";
    }

    // ----- What scan-screen.js calls -----

    // The Scan screen starts hidden, so the first time the web has a width is also when it's first laid out.
    let lastWidth = 0;
    new ResizeObserver(() => {
      const width = web.clientWidth;
      if (!width || width === lastWidth) return;
      lastWidth = width;
      view.relayout();
    }).observe(web);

    const view = {
      // Before a run: just "This PC", and a line saying what will grow from it.
      idle() {
        model = null;
        finished = false;
        clear();
        host.dataset.state = "idle";
        idleNote.hidden = false;
        rootParts.tName.textContent = t("ws.tmThisPc");
        drawnWidth = 0;
        if (layout()) rootParts.g.style.transform = `translate(${geometry.rootX}px, ${HEIGHT / 2}px)`;
      },
      begin() {
        clear();
        model = WebModel({ pins: MAX_PINS });
        finished = false;
        host.dataset.state = "running";
        drawn = -1;
        lastStep = 0;
        drawnWidth = 0;
        rootParts.tName.textContent = t("ws.tmThisPc");
        render();
      },
      started(file) {
        model?.started(file);
        kick();
      },
      done(file, state) {
        model?.done(file, state);
        kick();
      },
      end(stopped) {
        if (!model) return;
        cancelPace();
        model.end();
        finished = true;
        host.dataset.state = stopped ? "stopped" : "done";
        render();
      },
      // Draws what the model has right now, without waiting for the next step (a screenshot, a test).
      flush() {
        if (!model) return;
        cancelPace();
        model.step();
        render();
      },
      // A new language: the fixed words now, every node's and card's own on the next draw.
      relabel() {
        rootParts.tName.textContent = t("ws.tmThisPc");
        idleNote.textContent = t("ws.tmIdle");
        keptHead.textContent = t("ws.tmKept");
        for (const shownCard of [card, ...pins]) shownCard.state = null;
        for (const [, parts] of drawnNodes) parts.words = "";
        drawn = -1;
        if (model) render();
      },
      relayout() {
        drawnWidth = 0;
        if (!model) {
          view.idle();
          return;
        }
        render();
      },
      get model() {
        return model;
      },
    };
    return view;
  }

  globalThis.ClotrTrace = { WebModel, WebView, classify, lineWidths };
})();
