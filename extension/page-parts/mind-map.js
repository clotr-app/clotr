// Lays out and draws the mind map that page-parts/insights.js builds, plus its table view. Extension pages only, not
// a content script. The layout functions are pure and unit-tested; the drawing builds SVG and table rows
// with createElement, never innerHTML.
"use strict";

(() => {
  // ---------- Laying out the tree ----------

  const TAU = 2 * Math.PI;

  // Leaves under a node (at least 1), so a busy branch gets a wider slice of the circle.
  function weight(node) {
    if (!node.children?.length) return 1;
    return node.children.reduce((sum, child) => sum + weight(child), 0);
  }

  // Gives every node a depth and a slice of the circle [a0, a1) (radians, clockwise from `start`);
  // `angle` is the slice's middle. Children split their parent's slice by weight; each branch
  // around "You" gets at least `minShare` of the circle, so small ones don't crowd together.
  function layoutRadial(tree, { start = -Math.PI / 2, minShare = 0.14 } = {}) {
    function place(node, a0, a1, depth) {
      Object.assign(node, { depth, a0, a1, angle: (a0 + a1) / 2 });
      const children = node.children || [];
      const floor = depth === 0 && children.length * minShare < 1 ? minShare : 0;
      // Each gets its floor first; the rest of the circle is split by weight.
      const shares = children.map((child) => floor + ((1 - children.length * floor) * weight(child)) / weight(node));
      let from = a0;
      for (const [index, child] of children.entries()) {
        const span = (a1 - a0) * shares[index];
        place(child, from, from + span, depth + 1);
        from += span;
      }
    }
    place(tree, start, start + TAU, 0);
    tree.layout = "radial";
    return tree;
  }

  // A narrow window's version: the same tree as an indented outline from "You" down, one row
  // per node. Pure; gives every node x, y (and angle 0, so labels sit to the right).
  function layoutList(tree, { row = 36, indent = 30 } = {}) {
    let rowIndex = 0;
    function place(node, depth) {
      Object.assign(node, { depth, angle: 0, a0: 0, a1: 0, x: 22 + depth * indent, y: 22 + rowIndex++ * row });
      for (const child of node.children || []) place(child, depth + 1);
    }
    place(tree, 0);
    tree.layout = "list";
    return tree;
  }

  function walk(node, visit, parent = null) {
    visit(node, parent);
    for (const child of node.children || []) walk(child, visit, node);
  }

  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // How many levels sit below a node.
  function levels(node) {
    if (!node.children?.length) return 0;
    return 1 + Math.max(...node.children.map(levels));
  }

  // ---------- Where everything goes ----------

  const PAD = 8; // room around the drawing, inside its frame

  // Each ring's share of the radius, by depth.
  function ringsFor(deep, compact) {
    if (deep) return [0, 0.3, 0.64, 1];
    if (compact) return [0, 0.45, 1];
    return [0, 0.42, 1];
  }

  // How many characters an outer label may take.
  function labelCharsFor(deep, compact) {
    if (compact) return 18;
    return deep ? 26 : 18;
  }

  // A label sits on the node's outer side: to the right, to the left, or under or over it.
  function anchorFor(angle) {
    const cos = Math.cos(angle);
    if (cos > 0.08) return "start";
    if (cos < -0.08) return "end";
    return "middle";
  }

  function lineWidth(node) {
    if (node.type === "leaf" || node.type === "more") return 1;
    return 1.5 + Math.min(5, (node.count || 0) * 0.8);
  }

  function spaceOnRing(space, share, angle) {
    const { centerX, centerY, radiusX, radiusY } = space;
    return [centerX + radiusX * share * Math.cos(angle), centerY + radiusY * share * Math.sin(angle)];
  }

  function spacePlaceOf(space, node) {
    const { centerX, centerY, rings, list } = space;
    if (list) return [node.x, node.y];
    if (node.depth === 0) return [centerX, centerY];
    return spaceOnRing(space, rings[Math.min(node.depth, rings.length - 1)], node.angle);
  }

  function growBox(box, x0, y0, x1, y1) {
    box.x0 = Math.min(box.x0, x0);
    box.y0 = Math.min(box.y0, y0);
    box.x1 = Math.max(box.x1, x1);
    box.y1 = Math.max(box.y1, y1);
  }

  // A label beside a shape of radius r, on its outer side (under or over it when the node is
  // straight below or above "You").
  function layoutLabel(space, node, x, y, radius, text) {
    const { charWidth, box } = space;
    const anchor = anchorFor(node.angle);
    const below = Math.sin(node.angle) > 0;
    let labelX = 0;
    if (anchor === "start") labelX = radius + 4;
    if (anchor === "end") labelX = -radius - 4;
    let labelY = 4;
    if (anchor === "middle") labelY = below ? radius + 12 : -radius - 5;
    const textWidth = text.length * charWidth;
    let left = x + (labelX - textWidth / 2);
    if (anchor === "start") left = x + labelX;
    if (anchor === "end") left = x + (labelX - textWidth);
    growBox(box, left, y + labelY - 12, left + textWidth, y + labelY + 4);
    return { x: labelX, y: labelY, anchor, text };
  }

  // A branch's pill: its name and count, set apart.
  function layoutPill(space, node, x, y) {
    const { list, box } = space;
    const count = String(node.count);
    const pillWidth = (node.label.length + count.length + 1) * 7 + 20;
    const pillHeight = 26;
    const shift = list ? pillWidth / 2 - 12 : 0; // the outline's pills start at their line
    growBox(box, x + shift - pillWidth / 2, y - pillHeight / 2, x + shift + pillWidth / 2, y + pillHeight / 2);
    return { type: "pill", width: pillWidth, height: pillHeight, shift, name: node.label, count };
  }

  // An AI service's or kind's ring, with its count inside and its name beside.
  function layoutRing(space, node, x, y) {
    const { labelChars, compact } = space;
    const radius = compact ? 10 : 15;
    let mark = "";
    if (node.type === "cant-see") mark = "?";
    else if (node.count) mark = String(node.count);
    const name = node.label.replace(/^www\./, "");
    const text = layoutLabel(space, node, x, y, radius, clip(node.mentioned ? `${name} 💬` : name, labelChars));
    return { shape: { type: "ring", r: radius, mark }, text };
  }

  function layoutItem(space, node, parent) {
    const { rings, list, box, compact } = space;
    const [x, y] = spacePlaceOf(space, node);
    const [parentX, parentY] = spacePlaceOf(space, parent);
    // Curve out along the child's direction, from the parent's ring.
    // (In the outline: down from the parent, then across.)
    const share = rings[Math.max(0, node.depth - 1)] + 0.5 * (rings[node.depth] - rings[node.depth - 1] || 0);
    const via = list ? [parentX, y] : spaceOnRing(space, share, node.angle);
    const strokeWidth = lineWidth(node);
    let shape;
    let text = null;
    if (node.type === "branch" && compact) {
      // The popup's map: a junction dot on the line (the key under the map names the branch).
      shape = { type: "junction", r: 4.5 };
      growBox(box, x - 5, y - 5, x + 5, y + 5);
    } else if (node.type === "branch") {
      shape = layoutPill(space, node, x, y);
    } else if (node.type === "leaf" || node.type === "more") {
      shape = { type: "dot", r: 3.5 };
      text = layoutLabel(
        space,
        node,
        x,
        y,
        3.5,
        clip(node.count > 1 ? `${node.label} ×${node.count}` : node.label, 36),
      );
    } else {
      ({ shape, text } = layoutRing(space, node, x, y));
    }
    const line = { from: [parentX, parentY], via, to: [x, y], width: strokeWidth };
    return { node, parent, x, y, line, shape, label: text };
  }

  // Where everything in the drawing goes, for a tree laid out by layoutRadial() or layoutList(). Pure:
  // reads the tree, changes nothing, touches no page. `width`/`height` are the room to draw in, `compact`
  // is the popup's small version. Returns `you` ("You", with its x/y/r), `items` (every other node in
  // drawing order with its place, its curved line back to its parent, its shape and its label), and
  // `frame`, a first guess at the bounding box (text width is just guessed from character count here;
  // the drawing measures the real one afterwards).
  function mindMapLayout(tree, { width, height, compact = false }) {
    const centerX = width / 2;
    const centerY = height / 2;
    const deep = levels(tree) > 2;
    const rings = ringsFor(deep, compact);
    // Room at the sides for the outermost labels, never more than a third of the width.
    const labelChars = labelCharsFor(deep, compact);
    const radiusX = width / 2 - Math.min(width / 3, labelChars * (compact ? 4 : 6));
    const radiusY = height / 2 - (compact ? 22 : 40);
    const list = tree.layout === "list";
    const charWidth = compact ? 5.6 : 6.6;
    const box = { x0: centerX - 30, x1: centerX + 30, y0: centerY - 30, y1: centerY + 30 };
    // What the layout helpers above share: the middle, the rings' sizes, the label room and the box.
    const space = { centerX, centerY, rings, labelChars, radiusX, radiusY, list, charWidth, box, compact };

    const items = [];
    walk(tree, (node, parent) => {
      if (parent) items.push(layoutItem(space, node, parent));
    });

    const [youX, youY] = spacePlaceOf(space, tree);
    return {
      you: { x: youX, y: youY, r: compact ? 14 : 24 },
      items,
      frame: [
        Math.floor(box.x0 - PAD),
        Math.floor(box.y0 - PAD),
        Math.ceil(box.x1 - box.x0 + 2 * PAD),
        Math.ceil(box.y1 - box.y0 + 2 * PAD),
      ],
    };
  }

  // ---------- Drawing one node ----------

  // Line styles per branch: the same colors as the charts' Sent / Hidden, plus two of their own.
  const STROKE = {
    has: { stroke: "var(--series-2)" },
    near: { stroke: "var(--series-1)", "stroke-dasharray": "5 4" },
    open: { stroke: "var(--good-ink)", "stroke-dasharray": "1 4", "stroke-linecap": "round" },
    blind: { stroke: "var(--medium-fg)", "stroke-dasharray": "8 3 2 3" },
  };
  const RISK_RING = { high: "var(--high-fg)", medium: "var(--medium-fg)", low: "var(--low-fg)" };

  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text != null) node.textContent = text;
    return node;
  }

  // The node's shape, drawn around (0, 0).
  function drawShape(group, node, shape) {
    const color = STROKE[node.branch].stroke;
    if (shape.type === "junction") {
      group.append(
        svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: "var(--surface)", stroke: color, "stroke-width": 2.5 }),
      );
      return;
    }
    if (shape.type === "pill") {
      // "Already has" and its count, set apart: the count is the figure, the name says what it counts.
      const { width, height, shift } = shape;
      group.append(
        svgEl("rect", {
          x: shift - width / 2,
          y: -height / 2,
          width,
          height,
          rx: height / 2,
          fill: "var(--surface)",
          stroke: color,
          "stroke-width": 2,
        }),
      );
      const name = svgEl(
        "text",
        { x: shift, y: 4, "text-anchor": "middle", class: "mind-branch-label" },
        `${shape.name} `,
      );
      name.append(svgEl("tspan", { class: "mind-branch-count" }, shape.count));
      group.append(name);
      return;
    }
    if (shape.type === "dot") {
      group.append(svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: color }));
      return;
    }
    const ring = node.branch === "has" ? RISK_RING[node.severity] || STROKE.has.stroke : color;
    group.append(
      svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: "var(--surface)", stroke: ring, "stroke-width": 2.5 }),
    );
  }

  // The words drawn on a node, as one line, without the "?" and 💬 pictures.
  function shownWords(group) {
    return [...group.querySelectorAll("text")]
      .map((text) => text.textContent.replace(/\p{Extended_Pictographic}️?/gu, "").trim())
      .filter((words) => /[\p{L}\p{N}]/u.test(words))
      .join(" ");
  }

  // One node of the layout as an SVG group: what it is and its count (data attributes), its words for
  // screen readers, its shape and its label, drawn around (0, 0); renderMindMap() moves it to its place.
  function drawNode({ node, shape, label }, chosen) {
    const group = svgEl("g", { class: `mind-node mind-${node.type}` });
    group.dataset.id = node.id;
    group.dataset.nodeType = node.type;
    group.dataset.branch = node.branch;
    if (node.type === "service") group.dataset.service = node.key;
    if (node.type === "kind") group.dataset.kind = node.key;
    group.dataset.count = String(node.count || 0);
    if (chosen === node.id) group.classList.add("chosen");
    const text = node.detail || node.label;
    group.append(svgEl("title", {}, text));

    drawShape(group, node, shape);
    // The name before the count in the markup (they're drawn apart, so the order only shows in the words
    // below), with a space after it that isn't drawn, like the pill's, so "chatgpt.com" and "4" read as
    // two words.
    if (label) {
      const className = shape.type === "dot" ? "mind-leaf-label" : "mind-label";
      const words = shape.mark ? `${label.text} ` : label.text;
      group.append(svgEl("text", { x: label.x, y: label.y, "text-anchor": label.anchor, class: className }, words));
    }
    if (shape.mark) {
      group.append(svgEl("text", { x: 0, y: 4, "text-anchor": "middle", class: "mind-count" }, shape.mark));
    }

    // Its words for screen readers and voice control start with the words drawn on it, in the same order
    // ("chatgpt.com 4", "Already has 3"), so saying what you see reaches it (WCAG 2.5.3, label in name);
    // then what it means. A "?" or 💬 is left out: they're pictures, not words.
    const shown = shownWords(group);
    group.setAttribute("aria-label", node.detail && shown ? `${shown}: ${node.detail}` : text);
    return group;
  }

  // ---------- Fitting and moving the frame ----------

  // The frame that fits what was really drawn (text widths depend on the font); `estimate` stands
  // in while nothing is on screen (a hidden card).
  function measuredFrame(svg, estimate) {
    try {
      const bounds = svg.getBBox();
      if (bounds.width > 0 && bounds.height > 0) {
        return [
          Math.floor(bounds.x - PAD),
          Math.floor(bounds.y - PAD),
          Math.ceil(bounds.width + 2 * PAD),
          Math.ceil(bounds.height + 2 * PAD),
        ];
      }
    } catch {
      /* not rendered */
    }
    return estimate;
  }

  function ease(progress) {
    return 1 - (1 - progress) ** 3;
  }

  // Moves the SVG's frame to `to` over `ms`, easing out.
  function easeView(svg, to, ms) {
    const from = svg.viewBox.baseVal;
    const start = from?.width ? [from.x, from.y, from.width, from.height] : to;
    const startTime = performance.now();
    cancelAnimationFrame(svg.clotrFrame);
    function frame(now) {
      const progress = Math.min(1, (now - startTime) / ms);
      const view = to.map((value, index) => start[index] + (value - start[index]) * ease(progress));
      svg.setAttribute("viewBox", view.join(" "));
      if (progress < 1) svg.clotrFrame = requestAnimationFrame(frame);
    }
    svg.clotrFrame = requestAnimationFrame(frame);
  }

  // ---------- Drawing the map ----------

  const MOVE_MS = 440;

  // Which nodes and lines light up with a node: its line back to "You", and everything under it.
  function lineageFinder(tree) {
    const parentOf = new Map();
    walk(tree, (node, parent) => parent && parentOf.set(node.id, parent));
    return function lineage(node) {
      const ids = new Set();
      for (let up = node; up && up.depth > 0; up = parentOf.get(up.id)) ids.add(up.id);
      walk(node, (below) => ids.add(below.id));
      return ids;
    };
  }

  function light(svg, ids) {
    svg.classList.toggle("focusing", Boolean(ids));
    for (const part of svg.querySelectorAll("[data-id]")) {
      part.classList.toggle("lit", Boolean(ids?.has(part.dataset.id)));
    }
  }

  // A node you can choose by click, Enter or Space, which lights its lineage on hover or focus.
  function makeChoosable(svg, group, node, ids, onSelect) {
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    function choose() {
      svg.clotrChosen = node.id;
      for (const other of svg.querySelectorAll(".mind-node.chosen")) other.classList.remove("chosen");
      group.classList.add("chosen");
      onSelect(node);
    }
    group.addEventListener("click", choose);
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      choose();
    });
    group.addEventListener("pointerenter", () => light(svg, ids));
    group.addEventListener("pointerleave", () => light(svg, null));
    group.addEventListener("focus", () => light(svg, ids));
    group.addEventListener("blur", () => light(svg, null));
  }

  function linePath(node, line) {
    const path = svgEl("path", {
      d: `M ${line.from[0]} ${line.from[1]} Q ${line.via[0]} ${line.via[1]} ${line.to[0]} ${line.to[1]}`,
      fill: "none",
      "stroke-width": line.width,
      ...STROKE[node.branch],
    });
    path.dataset.id = node.id;
    return path;
  }

  function youGroup(you, label) {
    const group = svgEl("g", { class: "mind-you" });
    group.dataset.you = "";
    group.append(svgEl("circle", { cx: you.x, cy: you.y, r: you.r, fill: "var(--ink)" }));
    const words = { x: you.x, y: you.y + 4, "text-anchor": "middle", fill: "var(--page)", class: "mind-you-label" };
    group.append(svgEl("text", words, label));
    return group;
  }

  // The still map: the frame fits the drawing at once.
  function fitStill(svg, estimate, compact) {
    svg.setAttribute("viewBox", estimate.join(" "));
    const fit = measuredFrame(svg, estimate);
    svg.setAttribute("viewBox", fit.join(" "));
    // The popup's map keeps its own size: one unit is one pixel, so its words read like the popup's.
    if (compact) {
      svg.setAttribute("width", fit[2]);
      svg.setAttribute("height", fit[3]);
    }
    delete svg.dataset.moving;
  }

  // Lines follow once the nodes have arrived; the frame eases to the new size with them, then
  // settles on the exact size of the drawing.
  function startMoving(svg, lines, nodes, estimate, before) {
    lines.style.opacity = "0";
    svg.dataset.moving = "";
    if (!before) svg.setAttribute("viewBox", estimate.join(" "));
    else easeView(svg, estimate, MOVE_MS);
    // Two frames: the starting places are painted before the move begins, so it transitions.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const group of nodes) group.clotrPlace();
        lines.style.opacity = "";
      }),
    );
    clearTimeout(svg.clotrSettle);
    const settleMs = MOVE_MS + (before ? 0 : 3 * 70) + 80;
    svg.clotrSettle = setTimeout(() => {
      easeView(svg, measuredFrame(svg, estimate), 220);
      svg.clotrSettle = setTimeout(() => delete svg.dataset.moving, 260);
    }, settleMs);
  }

  // Draws a laid-out tree into `svg` (its data-room or first viewBox sets the space). compact: the
  // popup's version (not focusable, drawn still). onSelect(node): a branch or AI service/kind was
  // chosen. In the report the map moves: it grows out of "You" once, and on a redraw (the
  // toggle, a resize, new history) every node glides from where it was; new ones come out of their
  // parent. Hover or focus lights a node's line back to "You" and dims the rest. No motion for
  // people who ask their system for less.
  function renderMindMap(svg, tree, { compact = false, onSelect } = {}) {
    svg.dataset.room ??= svg.getAttribute("viewBox") || "0 0 960 720";
    const [, , width, height] = svg.dataset.room.split(/\s+/).map(Number);
    const { you, items, frame: estimate } = mindMapLayout(tree, { width, height, compact });
    const motion = !compact && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const before = svg.clotrPlaces || null; // id → [x, y] from the last drawing
    const places = new Map();
    const lineage = lineageFinder(tree);

    const lines = svgEl("g", { class: "mind-lines" });
    const nodes = [];
    for (const item of items) {
      const { node, parent, x, y, line } = item;
      places.set(node.id, [x, y]);
      lines.append(linePath(node, line));

      const group = drawNode(item, svg.clotrChosen);
      if (item.shape.type === "dot" || compact || !onSelect) group.setAttribute("role", "img");
      else makeChoosable(svg, group, node, lineage(node), onSelect);

      // Start where it was last time; a new node starts at its parent (on the first drawing, at "You").
      const from = before?.get(node.id) || (before && before.get(parent.id)) || [you.x, you.y];
      function place(point) {
        group.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
      }
      if (motion) {
        place(from);
        if (!before?.has(node.id)) group.style.opacity = "0";
        if (!before) group.style.transitionDelay = `${(node.depth - 1) * 70}ms`;
      } else place([x, y]);
      group.clotrPlace = () => {
        place([x, y]);
        group.style.opacity = "";
      };
      nodes.push(group);
    }

    svg.replaceChildren(lines, youGroup(you, tree.label), ...nodes);
    svg.clotrPlaces = places;

    if (!motion) fitStill(svg, estimate, compact);
    else startMoving(svg, lines, nodes, estimate, before);
    return tree;
  }

  // ---------- The table view ----------

  function rowDetail(node) {
    if (node.type === "more") return node.label;
    if (node.type === "cant-see") return node.children.map((child) => child.label).join(", ");
    return node.detail || node.label;
  }

  // One row per AI service, kind, spotted site or "can't see" entry.
  function mindMapRows(tree) {
    const rows = [];
    for (const branch of tree.children) {
      for (const node of branch.children) {
        const detail = rowDetail(node);
        rows.push({
          branch: branch.label,
          what: node.label,
          count: node.type === "cant-see" ? "" : String(node.count || ""),
          detail,
        });
      }
    }
    return rows;
  }

  function renderMindMapTable(tbody, tree) {
    const rows = mindMapRows(tree).map((row) => {
      const element = document.createElement("tr");
      for (const value of [row.branch, row.what, row.count, row.detail]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        element.append(cell);
      }
      return element;
    });
    tbody.replaceChildren(...rows);
  }

  globalThis.ClotrMindMap = {
    layoutRadial,
    layoutList,
    mindMapLayout,
    renderMindMap,
    mindMapRows,
    renderMindMapTable,
  };
})();
