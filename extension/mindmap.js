// Lays out and draws the mind map that insights.js builds, plus its table view. Extension pages only, not
// a content script. The layout functions are pure and unit-tested; the drawing builds SVG and table rows
// with createElement, never innerHTML.
"use strict";

(() => {
  const TAU = 2 * Math.PI;

  // Leaves under a node (at least 1), so a busy branch gets a wider slice of the circle.
  function weight(node) {
    return node.children?.length ? node.children.reduce((sum, c) => sum + weight(c), 0) : 1;
  }

  // Gives every node a depth and a slice of the circle [a0, a1) (radians, clockwise from `start`);
  // `angle` is the slice's middle. Children split their parent's slice by weight; each branch
  // around "You" gets at least `minShare` of the circle, so small ones don't crowd together.
  function layoutRadial(tree, { start = -Math.PI / 2, minShare = 0.14 } = {}) {
    const place = (node, a0, a1, depth) => {
      Object.assign(node, { depth, a0, a1, angle: (a0 + a1) / 2 });
      const kids = node.children || [];
      const floor = depth === 0 && kids.length * minShare < 1 ? minShare : 0;
      // Each gets its floor first; the rest of the circle is split by weight.
      const shares = kids.map((c) => floor + ((1 - kids.length * floor) * weight(c)) / weight(node));
      let a = a0;
      kids.forEach((child, i) => {
        const span = (a1 - a0) * shares[i];
        place(child, a, a + span, depth + 1);
        a += span;
      });
    };
    place(tree, start, start + TAU, 0);
    tree.layout = "radial";
    return tree;
  }

  // A narrow window's version: the same tree as an indented outline from "You" down, one row
  // per node. Pure; gives every node x, y (and angle 0, so labels sit to the right).
  function layoutList(tree, { row = 36, indent = 30 } = {}) {
    let i = 0;
    const place = (node, depth) => {
      Object.assign(node, { depth, angle: 0, a0: 0, a1: 0, x: 22 + depth * indent, y: 22 + i++ * row });
      for (const c of node.children || []) place(c, depth + 1);
    };
    place(tree, 0);
    tree.layout = "list";
    return tree;
  }

  const walk = (node, fn, parent = null) => {
    fn(node, parent);
    for (const c of node.children || []) walk(c, fn, node);
  };
  const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const levels = (n) => (n.children?.length ? 1 + Math.max(...n.children.map(levels)) : 0);
  const PAD = 8; // room around the drawing, inside its frame

  // Where everything in the drawing goes, for a tree laid out by layoutRadial() or layoutList(). Pure:
  // reads the tree, changes nothing, touches no page. `width`/`height` are the room to draw in, `compact`
  // is the popup's small version. Returns `you` ("You", with its x/y/r), `items` (every other node in
  // drawing order with its place, its curved line back to its parent, its shape and its label), and
  // `frame`, a first guess at the bounding box (text width is just guessed from character count here;
  // the drawing measures the real one afterwards).
  function mindMapLayout(tree, { width: W, height: H, compact = false }) {
    const cx = W / 2,
      cy = H / 2;
    const deep = levels(tree) > 2;
    const rings = deep ? [0, 0.3, 0.64, 1] : compact ? [0, 0.45, 1] : [0, 0.42, 1];
    // Room at the sides for the outermost labels, never more than a third of the width.
    const labelChars = compact ? 18 : deep ? 26 : 18;
    const rx = W / 2 - Math.min(W / 3, labelChars * (compact ? 4 : 6)),
      ry = H / 2 - (compact ? 22 : 40);
    const list = tree.layout === "list";
    const at = (n) => {
      if (list) return [n.x, n.y];
      if (n.depth === 0) return [cx, cy];
      const f = rings[Math.min(n.depth, rings.length - 1)];
      return [cx + rx * f * Math.cos(n.angle), cy + ry * f * Math.sin(n.angle)];
    };
    const box = { x0: cx - 30, x1: cx + 30, y0: cy - 30, y1: cy + 30 };
    const grow = (x0, y0, x1, y1) => {
      box.x0 = Math.min(box.x0, x0);
      box.y0 = Math.min(box.y0, y0);
      box.x1 = Math.max(box.x1, x1);
      box.y1 = Math.max(box.y1, y1);
    };
    const charW = compact ? 5.6 : 6.6;

    // A label beside a shape of radius r, on its outer side (under or over it when the node is
    // straight below or above "You").
    const label = (n, x, y, r, text) => {
      const c = Math.cos(n.angle);
      const anchor = c > 0.08 ? "start" : c < -0.08 ? "end" : "middle";
      const s = Math.sin(n.angle);
      const lx = anchor === "start" ? r + 4 : anchor === "end" ? -r - 4 : 0;
      const ly = anchor === "middle" ? (s > 0 ? r + 12 : -r - 5) : 4;
      const w = text.length * charW;
      const left = x + (anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2);
      grow(left, y + ly - 12, left + w, y + ly + 4);
      return { x: lx, y: ly, anchor, text };
    };

    const items = [];
    walk(tree, (n, parent) => {
      if (!parent) return;
      const [x, y] = at(n);
      const [px, py] = at(parent);
      // Curve out along the child's direction, from the parent's ring.
      // (In the outline: down from the parent, then across.)
      const f = rings[Math.max(0, n.depth - 1)] + 0.5 * (rings[n.depth] - rings[n.depth - 1] || 0);
      const via = list ? [px, y] : [cx + rx * f * Math.cos(n.angle), cy + ry * f * Math.sin(n.angle)];
      const width = n.type === "leaf" || n.type === "more" ? 1 : 1.5 + Math.min(5, (n.count || 0) * 0.8);
      let shape,
        text = null;
      if (n.type === "branch" && compact) {
        // The popup's map: a junction dot on the line (the key under the map names the branch).
        shape = { type: "junction", r: 4.5 };
        grow(x - 5, y - 5, x + 5, y + 5);
      } else if (n.type === "branch") {
        const count = String(n.count);
        const w = (n.label.length + count.length + 1) * 7 + 20,
          h = 26;
        const shift = list ? w / 2 - 12 : 0; // the outline's pills start at their line
        shape = { type: "pill", width: w, height: h, shift, name: n.label, count };
        grow(x + shift - w / 2, y - h / 2, x + shift + w / 2, y + h / 2);
      } else if (n.type === "leaf" || n.type === "more") {
        shape = { type: "dot", r: 3.5 };
        text = label(n, x, y, 3.5, clip(n.count > 1 ? `${n.label} ×${n.count}` : n.label, 36));
      } else {
        const r = compact ? 10 : 15;
        shape = { type: "ring", r, mark: n.type === "cant-see" ? "?" : n.count ? String(n.count) : "" };
        const name = n.label.replace(/^www\./, "");
        text = label(n, x, y, r, clip(n.mentioned ? `${name} 💬` : name, labelChars));
      }
      items.push({ node: n, parent, x, y, line: { from: [px, py], via, to: [x, y], width }, shape, label: text });
    });

    const [ux, uy] = at(tree);
    return {
      you: { x: ux, y: uy, r: compact ? 14 : 24 },
      items,
      frame: [
        Math.floor(box.x0 - PAD),
        Math.floor(box.y0 - PAD),
        Math.ceil(box.x1 - box.x0 + 2 * PAD),
        Math.ceil(box.y1 - box.y0 + 2 * PAD),
      ],
    };
  }

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
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text != null) node.textContent = text;
    return node;
  }

  // One node of the layout as an SVG group: what it is and its count (data attributes), its words for
  // screen readers, its shape and its label, drawn around (0, 0); renderMindMap() moves it to its place.
  function drawNode({ node: n, shape, label }, chosen) {
    const g = svgEl("g", { class: `mind-node mind-${n.type}` });
    g.dataset.id = n.id;
    g.dataset.nodeType = n.type;
    g.dataset.branch = n.branch;
    if (n.type === "service") g.dataset.service = n.key;
    if (n.type === "kind") g.dataset.kind = n.key;
    g.dataset.count = String(n.count || 0);
    if (chosen === n.id) g.classList.add("chosen");
    const text = n.detail || n.label;
    g.setAttribute("aria-label", text);
    g.append(svgEl("title", {}, text));

    const color = STROKE[n.branch].stroke;
    if (shape.type === "junction") {
      g.append(
        svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: "var(--surface)", stroke: color, "stroke-width": 2.5 }),
      );
    } else if (shape.type === "pill") {
      // "Already has" and its count, set apart: the count is the figure, the name says what it counts.
      const { width: w, height: h, shift } = shape;
      g.append(
        svgEl("rect", {
          x: shift - w / 2,
          y: -h / 2,
          width: w,
          height: h,
          rx: h / 2,
          fill: "var(--surface)",
          stroke: color,
          "stroke-width": 2,
        }),
      );
      const t = svgEl(
        "text",
        { x: shift, y: 4, "text-anchor": "middle", class: "mind-branch-label" },
        `${shape.name} `,
      );
      t.append(svgEl("tspan", { class: "mind-branch-count" }, shape.count));
      g.append(t);
    } else if (shape.type === "dot") {
      g.append(svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: color }));
    } else {
      const ring = n.branch === "has" ? RISK_RING[n.severity] || STROKE.has.stroke : color;
      g.append(
        svgEl("circle", { cx: 0, cy: 0, r: shape.r, fill: "var(--surface)", stroke: ring, "stroke-width": 2.5 }),
      );
      if (shape.mark) g.append(svgEl("text", { x: 0, y: 4, "text-anchor": "middle", class: "mind-count" }, shape.mark));
    }
    if (label) {
      const cls = shape.type === "dot" ? "mind-leaf-label" : "mind-label";
      g.append(svgEl("text", { x: label.x, y: label.y, "text-anchor": label.anchor, class: cls }, label.text));
    }
    return g;
  }

  // The frame that fits what was really drawn (text widths depend on the font); `estimate` stands
  // in while nothing is on screen (a hidden card).
  function measuredFrame(svg, estimate) {
    try {
      const b = svg.getBBox();
      if (b.width > 0 && b.height > 0)
        return [
          Math.floor(b.x - PAD),
          Math.floor(b.y - PAD),
          Math.ceil(b.width + 2 * PAD),
          Math.ceil(b.height + 2 * PAD),
        ];
    } catch {
      /* not rendered */
    }
    return estimate;
  }

  // Moves the SVG's frame to `to` over `ms`, easing out.
  const ease = (t) => 1 - (1 - t) ** 3;
  function easeView(svg, to, ms) {
    const from = svg.viewBox.baseVal;
    const start = from?.width ? [from.x, from.y, from.width, from.height] : to;
    const t0 = performance.now();
    cancelAnimationFrame(svg.clotrFrame);
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      svg.setAttribute("viewBox", to.map((v, i) => start[i] + (v - start[i]) * ease(t)).join(" "));
      if (t < 1) svg.clotrFrame = requestAnimationFrame(frame);
    };
    svg.clotrFrame = requestAnimationFrame(frame);
  }

  // Draws a laid-out tree into `svg` (its data-room or first viewBox sets the space). compact: the
  // popup's version (not focusable, drawn still). onSelect(node): a branch or AI service/kind was
  // chosen. In the report the map moves: it grows out of "You" once, and on a redraw (the
  // toggle, a resize, new history) every node glides from where it was; new ones come out of their
  // parent. Hover or focus lights a node's line back to "You" and dims the rest. No motion for
  // people who ask their system for less.
  const MOVE_MS = 440;
  function renderMindMap(svg, tree, { compact = false, onSelect } = {}) {
    svg.dataset.room ??= svg.getAttribute("viewBox") || "0 0 960 720";
    const [, , W, H] = svg.dataset.room.split(/\s+/).map(Number);
    const { you, items, frame: estimate } = mindMapLayout(tree, { width: W, height: H, compact });
    const motion = !compact && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const before = svg.clotrPlaces || null; // id → [x, y] from the last drawing
    const places = new Map();

    // Which nodes and lines light up with a node: its line back to "You", and everything under it.
    const parentOf = new Map();
    walk(tree, (n, p) => p && parentOf.set(n.id, p));
    const lineage = (n) => {
      const ids = new Set();
      for (let p = n; p && p.depth > 0; p = parentOf.get(p.id)) ids.add(p.id);
      walk(n, (d) => ids.add(d.id));
      return ids;
    };
    const light = (ids) => {
      svg.classList.toggle("focusing", Boolean(ids));
      for (const el of svg.querySelectorAll("[data-id]")) el.classList.toggle("lit", Boolean(ids?.has(el.dataset.id)));
    };
    const choosable = (g, n) => {
      if (compact || !onSelect) return g.setAttribute("role", "img");
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      const choose = () => {
        svg.clotrChosen = n.id;
        for (const other of svg.querySelectorAll(".mind-node.chosen")) other.classList.remove("chosen");
        g.classList.add("chosen");
        onSelect(n);
      };
      g.addEventListener("click", choose);
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
      const ids = lineage(n);
      g.addEventListener("pointerenter", () => light(ids));
      g.addEventListener("pointerleave", () => light(null));
      g.addEventListener("focus", () => light(ids));
      g.addEventListener("blur", () => light(null));
    };

    const lines = svgEl("g", { class: "mind-lines" });
    const nodes = [];
    for (const item of items) {
      const { node: n, parent, x, y, line } = item;
      places.set(n.id, [x, y]);
      const path = svgEl("path", {
        d: `M ${line.from[0]} ${line.from[1]} Q ${line.via[0]} ${line.via[1]} ${line.to[0]} ${line.to[1]}`,
        fill: "none",
        "stroke-width": line.width,
        ...STROKE[n.branch],
      });
      path.dataset.id = n.id;
      lines.append(path);

      const g = drawNode(item, svg.clotrChosen);
      if (item.shape.type === "dot") g.setAttribute("role", "img");
      else choosable(g, n);

      // Start where it was last time; a new node starts at its parent (on the first drawing, at "You").
      const from = before?.get(n.id) || (before && before.get(parent.id)) || [you.x, you.y];
      const place = (p) => (g.style.transform = `translate(${p[0]}px, ${p[1]}px)`);
      if (motion) {
        place(from);
        if (!before?.has(n.id)) g.style.opacity = "0";
        if (!before) g.style.transitionDelay = `${(n.depth - 1) * 70}ms`;
      } else place([x, y]);
      g.clotrPlace = () => {
        place([x, y]);
        g.style.opacity = "";
      };
      nodes.push(g);
    }

    const youNode = svgEl("g", { class: "mind-you" });
    youNode.dataset.you = "";
    youNode.append(svgEl("circle", { cx: you.x, cy: you.y, r: you.r, fill: "var(--ink)" }));
    youNode.append(
      svgEl(
        "text",
        { x: you.x, y: you.y + 4, "text-anchor": "middle", fill: "var(--page)", class: "mind-you-label" },
        tree.label,
      ),
    );
    svg.replaceChildren(lines, youNode, ...nodes);
    svg.clotrPlaces = places;

    if (!motion) {
      svg.setAttribute("viewBox", estimate.join(" "));
      const fit = measuredFrame(svg, estimate);
      svg.setAttribute("viewBox", fit.join(" "));
      // The popup's map keeps its own size: one unit is one pixel, so its words read like the popup's.
      if (compact) {
        svg.setAttribute("width", fit[2]);
        svg.setAttribute("height", fit[3]);
      }
      delete svg.dataset.moving;
      return tree;
    }
    // Lines follow once the nodes have arrived; the frame eases to the new size with them, then
    // settles on the exact size of the drawing.
    lines.style.opacity = "0";
    svg.dataset.moving = "";
    if (!before) svg.setAttribute("viewBox", estimate.join(" "));
    else easeView(svg, estimate, MOVE_MS);
    // Two frames: the starting places are painted before the move begins, so it transitions.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const g of nodes) g.clotrPlace();
        lines.style.opacity = "";
      }),
    );
    clearTimeout(svg.clotrSettle);
    const settleMs = MOVE_MS + (before ? 0 : 3 * 70) + 80;
    svg.clotrSettle = setTimeout(() => {
      easeView(svg, measuredFrame(svg, estimate), 220);
      svg.clotrSettle = setTimeout(() => delete svg.dataset.moving, 260);
    }, settleMs);
    return tree;
  }

  // The table view: one row per AI service, kind, spotted site or "can't see" entry.
  function mindMapRows(tree) {
    const rows = [];
    for (const branch of tree.children)
      for (const n of branch.children) {
        const detail =
          n.type === "more"
            ? n.label
            : n.type === "cant-see"
              ? n.children.map((c) => c.label).join(", ")
              : n.detail || n.label;
        rows.push({
          branch: branch.label,
          what: n.label,
          count: n.type === "cant-see" ? "" : String(n.count || ""),
          detail,
        });
      }
    return rows;
  }

  function renderMindMapTable(tbody, tree) {
    tbody.replaceChildren(
      ...mindMapRows(tree).map((r) => {
        const tr = document.createElement("tr");
        for (const v of [r.branch, r.what, r.count, r.detail]) {
          const td = document.createElement("td");
          td.textContent = v;
          tr.append(td);
        }
        return tr;
      }),
    );
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
