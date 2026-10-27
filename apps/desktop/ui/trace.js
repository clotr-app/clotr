// Clotr for Windows' Scan screen: the growing web. Every folder the run reads is a node joined to its parent, and it
// grows as its files are read. Once Clotr is done with a folder its node turns green, amber or red, with a small bead
// for each find. The card for the file being read floats beside its folder on a dotted trace and sends a few dots a
// second into it. Below the web, one row keeps the files worth a look and a count covers everything else.
// A Quick scan reads thousands of files and a Full one hundreds of thousands, so nothing here is drawn per file.
// WebModel is plain data with no page, so Node's tests run it as is. It holds a bounded number of nodes (top folders
// and their subfolders, past a few of each the rest share one node), the kept finds and a handful of counts.
// WebView draws it at most once per step. It only ever holds what scan.js already has from scan_batch (a name, a
// folder label, the name of the folder a file sits in, an index) and a file's kinds, never a path and never a value.
"use strict";

(() => {
  const SVG = "http://www.w3.org/2000/svg";

  // A read file's settled state, the same split Results makes: a kind worth a look (red or orange, or a photo's
  // place), only personal details (amber), nothing at all, or a file the reader couldn't open.
  function classify(file, isWorthALook) {
    if (file.reason) return "unread";
    if (!file.found || !Object.keys(file.found).length) return "clean";
    return isWorthALook(file) ? "look" : "personal";
  }

  // ---------- The web's own data ----------
  // `started` hears each file as its read begins and `done` as it lands. A file lands in its folder's node: the top
  // folder (`folder`, a known folder's key, a drive or a chosen folder) or one of its subfolders (`parent`, the name
  // of the folder the file sits in). Past `subCap` subfolders in a top folder, the rest share one node, and past
  // `topCap` top folders the rest share one too. A node is done once the run has moved on to another folder, and only
  // then takes its colour. `step` (the view's pace, never per file) picks what the card shows: a find that landed
  // since the last step, held for `hold` steps, or else the newest file being read.
  function WebModel({ topCap = 4, subCap = 6, pins = 6, hold = 3 } = {}) {
    let version = 0;
    let read = 0;
    const counts = { clean: 0, personal: 0, unread: 0, look: 0 };
    const kept = [];
    const nodes = [];
    const tops = [];
    const byTop = new Map(); // top folder label -> its node
    let moreTops = null;
    let active = null; // the node the newest landed file went into
    let now = null; // the newest file being read
    let pending = null; // the newest find since the last step
    let card = null;
    let held = 0;
    let ended = false;

    function node(key, label, depth, parent, more = false) {
      const n = {
        key,
        label,
        depth,
        parent,
        more,
        kids: [],
        subs: new Map(),
        read: 0,
        all: 0,
        look: 0,
        personal: 0,
        unread: 0,
        kidLook: 0,
        kidPersonal: 0,
        kidUnread: 0,
        done: false,
        merged: 0,
        lastName: null,
        order: nodes.length,
      };
      if (parent) parent.kids.push(n);
      nodes.push(n);
      return n;
    }
    const root = { key: "", label: null, depth: 0, kids: [], read: 0, all: 0, look: 0, personal: 0, done: false };

    // A shared node counts the folders it stands for as the run walks into each one; a folder's files arrive
    // together, so a new name is a new folder, with nothing kept per name.
    function merge(n, name) {
      if (n.lastName === name) return;
      n.lastName = name;
      n.merged++;
    }
    function topFor(file, create) {
      let top = byTop.get(file.folder);
      if (top || !create) return top || moreTops;
      if (tops.length < topCap) {
        top = node(file.folder, file.folder, 1, root);
        tops.push(top);
        byTop.set(file.folder, top);
        return top;
      }
      if (!moreTops) {
        moreTops = node("…", null, 1, root, true);
        tops.push(moreTops);
      }
      return moreTops;
    }
    // The node a file goes into. Its top folder's own files (sitting right in Documents, or at a drive's root) go
    // into the top folder's node.
    function nodeFor(file, create) {
      const top = topFor(file, create);
      if (!top) return null;
      if (top.more) {
        if (create) merge(top, file.folder);
        return top;
      }
      const name = file.parent || "";
      if (!name || name.toLowerCase() === String(file.folder).toLowerCase()) return top;
      const sub = top.subs.get(name);
      if (sub) return sub;
      const more = top.subs.get("…");
      if (top.subs.size - (more ? 1 : 0) < subCap) {
        if (!create) return top;
        const n = node(`${top.key}/${name}`, name, 2, top);
        top.subs.set(name, n);
        return n;
      }
      if (!create) return more || top;
      let m = more;
      if (!m) {
        m = node(`${top.key}/…`, null, 2, top, true);
        top.subs.set("…", m);
      }
      merge(m, name);
      return m;
    }
    const topOf = (n) => (n.depth === 1 ? n : n.parent);

    function entry(file) {
      return { index: file.index, name: file.name, folder: file.folder, parent: file.parent || "", found: null };
    }
    function started(file) {
      now = entry(file);
      version++;
    }
    function done(file, state) {
      const n = nodeFor(file, true);
      const top = topOf(n);
      n.read++;
      n.all++;
      if (n !== top) top.all++;
      root.all++;
      if (state === "look" || state === "personal" || state === "unread") {
        n[state]++;
        if (n !== top) top[`kid${state[0].toUpperCase()}${state.slice(1)}`]++;
      }
      // Moving on: the folder just left is done, and its top folder too once the run leaves that.
      if (n !== active) {
        const old = active;
        active = n;
        n.done = false;
        top.done = false;
        if (old) {
          if (old !== n.parent) old.done = true;
          const oldTop = topOf(old);
          if (oldTop !== top) {
            oldTop.done = true;
            for (const k of oldTop.kids) k.done = true;
          }
        }
      }
      read++;
      counts[state]++;
      if (state === "look" || state === "personal") {
        const e = now && now.index === file.index ? now : entry(file);
        e.found = file.found;
        e.state = state;
        if (state === "look" && kept.length < pins) kept.push(e);
        // Worth a look wins the card over personal details landing in the same step.
        if (!pending || state === "look" || pending.state !== "look") pending = e;
      }
      version++;
    }
    function step() {
      if (ended) return false;
      const before = card;
      if (pending) {
        card = pending;
        pending = null;
        held = hold;
      } else if (held > 0) {
        held--;
      } else if (now && card?.index !== now.index) {
        card = { ...now, state: null };
      }
      if (card === before) return false;
      version++;
      return true;
    }
    // The run is over: every folder is done, and nothing is being read.
    function end() {
      ended = true;
      for (const n of nodes) n.done = true;
      active = null;
      now = null;
      pending = null;
      card = null;
      version++;
    }
    // One row of kept finds in `slots` places: every one, or as many as leave a place for "+N more".
    function pinRow(slots) {
      const total = counts.look;
      if (total <= slots) return { shown: kept.slice(0, total), more: 0 };
      const shown = kept.slice(0, Math.max(0, slots - 1));
      return { shown, more: total - shown.length };
    }
    // A done folder's colour: red for anything worth a look in it (or under it), amber for personal details only,
    // grey when nothing in it could be opened, green otherwise. Nothing until it's done.
    function colour(n) {
      if (!n.done || !n.all) return null;
      if (n.look + n.kidLook) return "look";
      if (n.personal + n.kidPersonal) return "personal";
      if (n.unread + n.kidUnread === n.all) return "unread";
      return "clean";
    }
    return {
      started,
      done,
      step,
      end,
      pinRow,
      colour,
      nodeOf: (file) => nodeFor(file, false) || root,
      root,
      get nodes() {
        return nodes;
      },
      get tops() {
        return tops;
      },
      get active() {
        return active;
      },
      get card() {
        return card;
      },
      get kept() {
        return kept;
      },
      get counts() {
        return counts;
      },
      get read() {
        return read;
      },
      get version() {
        return version;
      },
    };
  }

  // ---------- Drawing it ----------
  const STEP_MS = 650; // the card's pace: slow enough to read, quick enough to keep up with the run
  const IDLE_STEP_MS = 2000; // nobody's touched the window for a while (main.js's data-idle)
  const H = 440;
  const CARD_H = 136;
  const LINES = 5;
  const MAX_BEADS = 5;
  const BEAD_ANGLES = [145, 215, 118, 242, 92].map((a) => (a * Math.PI) / 180);
  const PIN_W = 180;
  const PIN_GAP = 18;
  const MAX_PINS = 6;
  const DOTS = 3;
  const ROOT_X = 46;
  const ROOT_LABEL_X = 12;

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  function icon(id, cls = "tm-icon") {
    const svg = svgEl("svg", { class: cls, "aria-hidden": "true", focusable: "false" });
    svg.append(svgEl("use", { href: `#${id}` }));
    return svg;
  }
  function div(cls, text) {
    const el = document.createElement("div");
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function brackets() {
    const b = span("tm-brk");
    for (let i = 0; i < 4; i++) b.append(document.createElement("i"));
    return b;
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
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const px = (n) => n.toFixed(1);

  function WebView(host, { t, fmt, folderName, kindOf, crumb }) {
    const root = document.documentElement;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    const still = () => root.dataset.motion === "still" || Boolean(reduce?.matches);
    const unseen = () => root.dataset.visible === "false";
    const quiet = () => still() || root.dataset.idle === "true";

    let model = null;
    let drawn = -1;
    let W = 0;
    let geo = null;
    let lastStep = 0;
    let frame = 0;
    let timer = null;
    let finished = false;
    let lastActive = null;

    // ----- The parts, built once -----
    const board = div("tm-board");
    const web = div("tm-web");
    const svg = svgEl("svg", { class: "tm-web-svg", "aria-hidden": "true" });
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: "tm-wg", gradientUnits: "userSpaceOnUse", x1: "0", y1: "0", y2: "0" });
    grad.append(svgEl("stop", { offset: "0", style: "stop-color: var(--tm-g1)" }));
    grad.append(svgEl("stop", { offset: "1", style: "stop-color: var(--tm-g2)" }));
    defs.append(grad);
    const gLinks = svgEl("g");
    const leader = svgEl("path", { class: "tm-leader" });
    const gNodes = svgEl("g");
    svg.append(defs, gLinks, leader, gNodes);
    const dots = [];
    for (let i = 0; i < DOTS; i++) dots.push(span("tm-dot"));
    const idleNote = div("tm-idle", t("ws.tmIdle"));
    web.append(svg, ...dots, idleNote);

    // The card for the file being read: placed with the `translate` property, never `transform`, so its grow-while-
    // reading `scale` can't multiply the distance it's moved by.
    const card = makeCard(false);
    card.el.hidden = true;
    web.append(card.el);

    const keptEl = div("tm-kept");
    const keptHead = div("tm-kept-head", t("ws.tmKept"));
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
    const STATE_WORD = { reading: "ws.tmReading", personal: "ws.tmPersonal", look: "ws.tmLook" };
    function where(e) {
      const top = folderName(e.folder);
      return e.parent && e.parent.toLowerCase() !== String(e.folder).toLowerCase() ? `${top} › ${e.parent}` : top;
    }
    function fill(c, e, state) {
      if (c.key !== e.index) {
        c.key = e.index;
        c.state = null;
        c.name.textContent = e.name;
        c.dir.textContent = where(e);
        lineWidths(e.index).forEach((w, i) => (c.bars[i].style.width = `${w}%`));
      }
      if (c.state === state) return;
      c.state = state;
      c.el.dataset.s = state;
      const id = `i-st-${state}`;
      c.stateIcon.firstChild.setAttribute("href", `#${id}`);
      c.chipIcon.firstChild.setAttribute("href", `#${id}`);
      c.chip.className = `tm-chip ${state}`;
      c.chipWords.textContent = t(STATE_WORD[state]);
      // Where the find sits on the card is made up too (the reader never says which line): one line, picked by the
      // file's index, is where the band settles, with the kind Results would name first.
      const find = state === "look" || state === "personal";
      const hit = (e.index * 7) % LINES;
      c.bars.forEach((bar, i) => (bar.className = find && i === hit ? "hit" : ""));
      c.tag.textContent = find ? kindOf(e.found) : "";
      c.tag.style.top = `${hit * 9 - 6}px`;
      c.hl.style.top = `${hit * 9 - 4}px`;
      c.clot.style.top = `${hit * 9 - 12}px`;
    }

    // ----- Nodes: one SVG group each, made the first time the model has the node, never one per file.
    const drawnNodes = new Map(); // model node -> its parts
    function nodeParts(n) {
      let p = drawnNodes.get(n);
      if (p) return p;
      const g = svgEl("g", { class: `wn d${n.depth}` });
      const halo = svgEl("circle", { class: "wn-halo", r: "12" });
      const dot = svgEl("circle", { class: "wn-dot", r: "0" });
      const beads = svgEl("g");
      const label = svgEl("text", { class: "wn-label" });
      const tName = svgEl("tspan", { class: "wn-name" });
      const tCount = svgEl("tspan", { class: "wn-count", dx: "6" });
      const tLook = svgEl("tspan", { class: "wn-look", dx: "8" });
      const tPers = svgEl("tspan", { class: "wn-pers", dx: "6" });
      label.append(tName, tCount, tLook, tPers);
      g.append(halo, dot, beads, label);
      gNodes.append(g);
      p = {
        g,
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
      p.link = svgEl("path", { class: "wl", pathLength: "1" });
      gLinks.append(p.link);
      // Born where its parent is, so it grows out of it.
      const from = n.parent ? drawnNodes.get(n.parent) : null;
      p.x = from ? from.x : geo.rootX;
      p.y = from ? from.y : H / 2;
      p.r = 0;
      p.fresh = true;
      drawnNodes.set(n, p);
      return p;
    }
    const rootParts = (() => {
      const g = svgEl("g", { class: "wn d0 root" });
      const dot = svgEl("circle", { class: "wn-dot", r: "9" });
      // Starts just inside the web's left edge: centred on a dot this close to it, a longer name ran off.
      const label = svgEl("text", { class: "wn-label", x: String(ROOT_LABEL_X - ROOT_X), y: "27" });
      const tName = svgEl("tspan", { class: "wn-name" });
      const tCount = svgEl("tspan", { class: "wn-count", dx: "6" });
      label.append(tName, tCount);
      g.append(dot, label);
      gNodes.append(g);
      return { g, tName, tCount };
    })();

    function looks(n) {
      return n.look + (n.kidLook || 0);
    }
    function pers(n) {
      return n.personal + (n.kidPersonal || 0);
    }
    function nameOf(n) {
      if (!n.more) return n.depth === 1 ? folderName(n.label) : n.label;
      if (n.merged === 1 && n.lastName) return n.depth === 1 ? folderName(n.lastName) : n.lastName;
      return t("ws.tmMoreFolders", fmt(n.merged));
    }
    function radius(n) {
      if (n.depth === 1) return 5 + Math.min(10, Math.sqrt(n.all) / 4);
      return 3.5 + Math.min(8, Math.sqrt(n.read) / 3);
    }

    // ----- Layout: the root on the left, top folders in a column, their subfolders in the next, the card on the
    // right. Rows share the web's height, so a few dozen nodes always fit.
    function layout() {
      const w = web.clientWidth;
      if (!w) return false;
      if (w === W && geo) return true;
      W = w;
      const narrow = W < 760;
      const cardW = narrow ? 184 : 210;
      const leafX = W * (narrow ? 0.4 : 0.46);
      const cardX = W - cardW - 22;
      geo = {
        rootX: ROOT_X,
        topX: Math.max(150, W * (narrow ? 0.19 : 0.22)),
        leafX,
        cardW,
        cardX,
        // A subfolder's name, its count and its marks end before the card starts: in a half-screen window a
        // 22-letter name once ran under the card. About 7 px a letter, and about 90 px for the dot, count and marks.
        nameMax: Math.max(10, Math.min(narrow ? 14 : 22, Math.floor((cardX - leafX - 90) / 7))),
      };
      grad.setAttribute("x1", String(geo.rootX));
      grad.setAttribute("x2", String(geo.leafX + 60));
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
      const s = list.length > 1 ? Math.min(34, (H - 64) / (list.length - 1)) : 0;
      const y0 = (H - s * (list.length - 1)) / 2 - 6;
      const at = new Map();
      list.forEach((n, i) => at.set(n, { x: n.depth === 1 ? geo.topX : geo.leafX, y: y0 + i * s }));
      for (const top of model.tops) {
        if (top.kids.length) {
          const ys = top.kids.map((k) => at.get(k).y);
          at.set(top, { x: geo.topX, y: ys.reduce((a, y) => a + y, 0) / ys.length });
        }
      }
      const tys = model.tops.map((tp) => at.get(tp).y);
      const rootY = tys.length ? tys.reduce((a, y) => a + y, 0) / tys.length : H / 2;
      return { at, rootY };
    }
    function linkD(a, b) {
      const x1 = a.x + a.r + 1;
      const x2 = b.x - b.r - 1;
      const m = (x2 - x1) / 2;
      return `M${px(x1)} ${px(a.y)} C${px(x1 + m)} ${px(a.y)} ${px(x2 - m)} ${px(b.y)} ${px(x2)} ${px(b.y)}`;
    }
    function bead(p, state, n) {
      const a = BEAD_ANGLES[n];
      const g = svgEl("g", { class: `wbead ${state}` });
      const stub = svgEl("line", { class: "wstub" });
      const mark =
        state === "look"
          ? svgEl("circle", { class: "wsat", r: "4.2" })
          : svgEl("path", { class: "wsat", d: "M0 -4.6 4.4 3.4H-4.4z" });
      g.append(stub, mark);
      p.beads.append(g);
      return { g, stub, mark, a };
    }
    function placeBeads(p, n) {
      // One bead per find in this folder, worth a look first, up to a handful; the label carries the full count.
      const want = Math.min(MAX_BEADS, n.look + n.personal);
      while (p.beadN < want) {
        const i = p.beadN;
        p.beadN++;
        (p.beadList ||= []).push(bead(p, i < n.look ? "look" : "personal", i));
      }
      for (const b of p.beadList || []) {
        const r0 = p.r + 1;
        const r1 = p.r + 11;
        const cx = Math.cos(b.a) * r1;
        const cy = -Math.sin(b.a) * r1;
        b.stub.setAttribute("x1", px(Math.cos(b.a) * r0));
        b.stub.setAttribute("y1", px(-Math.sin(b.a) * r0));
        b.stub.setAttribute("x2", px(cx));
        b.stub.setAttribute("y2", px(cy));
        b.mark.setAttribute("transform", `translate(${px(cx)} ${px(cy)})`);
      }
    }
    function words(p, n) {
      const name = short(nameOf(n), geo.nameMax);
      const L = looks(n);
      const P = pers(n);
      const key = `${name}|${n.all}|${L}|${P}`;
      if (key === p.words) return;
      p.words = key;
      p.tName.textContent = name;
      p.tCount.textContent = fmt(n.depth === 2 ? n.read : n.all);
      p.tLook.textContent = L ? `● ${fmt(L)}` : "";
      p.tPers.textContent = P ? `▲ ${fmt(P)}` : "";
      p.tPers.setAttribute("dx", L ? "6" : "8");
    }
    function placeLabel(p, n) {
      const mode = n.depth === 1 && n.kids.length ? "above" : "right";
      if (mode !== p.mode) {
        p.mode = mode;
        p.label.setAttribute("text-anchor", mode === "right" ? "start" : "middle");
      }
      if (mode === "right") {
        p.label.setAttribute("x", px(p.r + 8));
        p.label.setAttribute("y", "4.5");
      } else {
        p.label.setAttribute("x", "0");
        p.label.setAttribute("y", px(-p.r - 9));
      }
    }

    // ----- One step's worth: only what changed since the last one.
    function render() {
      if (!model || !layout()) return;
      const { at, rootY } = rows();
      const rootPos = { x: geo.rootX, y: rootY, r: 9 };
      rootParts.g.style.transform = `translate(${px(rootPos.x)}px, ${px(rootPos.y)}px)`;
      rootParts.tCount.textContent = model.read ? fmt(model.read) : "";
      const act = model.active;
      const actTop = act ? (act.depth === 1 ? act : act.parent) : null;
      let fresh = false;
      for (const n of model.nodes) {
        const p = nodeParts(n);
        if (p.fresh) fresh = true;
      }
      // A new node is drawn once where it's born before it moves, so it grows out of its parent.
      if (fresh && !quiet()) {
        for (const [, p] of drawnNodes) {
          if (!p.fresh) continue;
          p.g.style.transform = `translate(${px(p.x)}px, ${px(p.y)}px)`;
        }
        void svg.getBoundingClientRect();
      }
      for (const n of model.nodes) {
        const p = drawnNodes.get(n);
        p.fresh = false;
        const to = at.get(n);
        p.x = to.x;
        p.y = to.y;
        p.r = radius(n);
        p.g.style.transform = `translate(${px(p.x)}px, ${px(p.y)}px)`;
        p.dot.style.r = `${px(p.r)}px`;
        p.halo.setAttribute("r", px(p.r + 6));
        const parent = n.depth === 1 ? rootPos : drawnNodes.get(n.parent);
        p.link.style.d = `path("${linkD(parent, p)}")`;
        placeLabel(p, n);
        placeBeads(p, n);
        words(p, n);
        const on = !finished && act && (n === act || n === actTop);
        const c = model.colour(n);
        const cls = `wn d${n.depth}${on ? " active" : ""}${n === act && !finished ? " lead" : ""}${
          !on && c ? ` s-${c}` : ""
        }${looks(n) ? " has-look" : ""}${pers(n) ? " has-pers" : ""}`;
        if (cls !== p.cls) {
          p.cls = cls;
          p.g.setAttribute("class", cls);
          p.link.classList.toggle("on", Boolean(on));
        }
      }
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

    // The card beside its folder, the dotted trace between them, and the dots it sends home along it.
    function drawCard() {
      const e = finished ? null : model.card;
      card.el.hidden = !e;
      leader.style.display = e ? "" : "none";
      for (const d of dots) d.hidden = !e;
      web.classList.toggle("has-card", Boolean(e));
      if (crumb) crumb.textContent = e ? `${where(e)} › ${e.name}` : "";
      if (!e) return;
      const changed = card.key !== e.index;
      fill(card, e, e.state || "reading");
      if (changed && !quiet()) {
        card.el.classList.remove("swap");
        void card.el.offsetWidth;
        card.el.classList.add("swap");
      }
      const n = model.nodeOf(e);
      const p = n === model.root ? null : drawnNodes.get(n);
      const nx = p ? p.x : geo.rootX;
      const ny = p ? p.y : H / 2;
      const nr = p ? p.r : 9;
      const y = Math.max(14, Math.min(H - CARD_H - 14, ny - CARD_H / 2));
      card.el.style.translate = `${px(geo.cardX)}px ${px(y)}px`;
      card.el.dataset.x = px(geo.cardX);
      // The trace leaves from the end of the folder's label, so it never crosses its name.
      const labelEnd = p && p.mode === "right" ? 16 + p.label.getComputedTextLength() : 4;
      const sx = nx + nr + labelEnd;
      const ex = geo.cardX - 6;
      const ey = y + CARD_H / 2;
      const m = (ex - sx) / 2;
      const d = `M${px(ex)} ${px(ey)} C${px(ex - m)} ${px(ey)} ${px(sx + m)} ${px(ny)} ${px(sx)} ${px(ny)}`;
      leader.style.d = `path("${d}")`;
      for (const dot of dots) dot.style.offsetPath = `path("${d}")`;
    }

    // Anything worth a look: one row, as many as fit, then "+N more worth a look in Results"; the rest counted.
    const pins = [];
    function drawKept() {
      const w = keptRow.clientWidth;
      const slots = Math.min(MAX_PINS, Math.max(2, Math.floor((w + PIN_GAP) / (PIN_W + PIN_GAP))));
      keptRow.style.setProperty("--tm-slots", String(slots));
      const { shown, more: extra } = model.pinRow(slots);
      while (pins.length < shown.length) {
        const c = makeCard(true);
        keptRow.insertBefore(c.el, tile);
        pins.push(c);
      }
      pins.forEach((c, i) => {
        c.el.hidden = i >= shown.length;
        if (i < shown.length) fill(c, shown[i], "look");
      });
      tile.hidden = !extra;
      if (extra) tile.textContent = t("ws.tmMoreLook", fmt(extra));
      keptEl.classList.toggle("has", shown.length > 0);
      const counts = model.counts;
      for (const [key, word] of [
        ["personal", "ws.tmMorePersonal"],
        ["unread", "ws.tmMoreUnread"],
        ["clean", "ws.tmMoreClean"],
      ]) {
        moreChips[key].chip.hidden = !counts[key];
        if (counts[key]) moreChips[key].label.textContent = t(word, fmt(counts[key]));
      }
    }

    // ----- Pace: a step at most every STEP_MS, drawn on an animation frame, and nothing at all while the window
    // is hidden (the next file to land after it's back draws it again).
    function tick() {
      frame = 0;
      lastStep = performance.now();
      model?.step();
      if (model && model.version !== drawn) render();
    }
    function kick() {
      if (frame || timer || !model || unseen()) return;
      const pace = root.dataset.idle === "true" ? IDLE_STEP_MS : STEP_MS;
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

    function clear() {
      cancelPace();
      for (const [, p] of drawnNodes) {
        p.g.remove();
        p.link.remove();
      }
      drawnNodes.clear();
      for (const c of pins) c.el.remove();
      pins.length = 0;
      tile.hidden = true;
      card.el.hidden = true;
      card.key = null;
      card.state = null;
      leader.style.display = "none";
      for (const d of dots) d.hidden = true;
      web.classList.remove("has-card");
      for (const { chip } of Object.values(moreChips)) chip.hidden = true;
      keptEl.classList.remove("has");
      lastActive = null;
      rootParts.tCount.textContent = "";
      if (crumb) crumb.textContent = "";
    }

    // The Scan screen starts hidden, so the first time the web has a width is also when it's first laid out.
    let lastWidth = 0;
    new ResizeObserver(() => {
      const w = web.clientWidth;
      if (!w || w === lastWidth) return;
      lastWidth = w;
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
        W = 0;
        if (layout()) rootParts.g.style.transform = `translate(${geo.rootX}px, ${H / 2}px)`;
      },
      begin() {
        clear();
        model = WebModel({ pins: MAX_PINS });
        finished = false;
        host.dataset.state = "running";
        drawn = -1;
        lastStep = 0;
        W = 0;
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
        for (const c of [card, ...pins]) c.state = null;
        for (const [, p] of drawnNodes) p.words = "";
        drawn = -1;
        if (model) render();
      },
      relayout() {
        W = 0;
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
