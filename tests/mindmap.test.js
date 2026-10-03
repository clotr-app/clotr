// The mind map of everything you could be leaking (D75): its model and its layout, without a browser.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js"); // pattern names for kinds (English here)
require("../extension/insights.js");
require("../extension/mindmap.js");
const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
const { layoutRadial, mindMapRows, mindMapLayout } = globalThis.ClotrMindMap; // layoutList is read in its own tests

const ev = (site, type, action, fp = "", severity = "medium") => ({
  t: 1,
  site,
  type,
  name: type,
  severity,
  action,
  fp,
});
const EVENTS = [
  ev("chatgpt.com", "phone_number", "allowed", "a000000000000001"),
  ev("chatgpt.com", "phone_number", "allowed", "a000000000000001"),
  ev("chatgpt.com", "email", "suppressed", "a000000000000002", "low"),
  ev("claude.ai", "aws_access_key", "redacted", "a000000000000003", "high"),
  ev("claude.ai", "credit_card", "allowed", "a000000000000004", "high"),
];
const MENTIONS = [ev("gemini.google.com", "my_name", "mentioned", "b000000000000001", "high")];
const VAULT = [
  { kind: "value", type: "phone_number", fp: "a000000000000001", mode: "protect" }, // was sent
  { kind: "value", type: "street_address", fp: "c000000000000001", mode: "protect" }, // never sent
  { kind: "value", type: "street_address", fp: "c000000000000002", mode: "protect" }, // never sent
  { kind: "value", type: "email", fp: "c000000000000003", mode: "allow" }, // fine to share: not "at risk"
  { kind: "word", type: "my_name", fp: "b000000000000001" }, // brought up in a reply
  { kind: "word", type: "family_name", fp: "c000000000000004" }, // never sent
];
const model = () => exposureModel({ events: EVENTS, mentions: MENTIONS, vault: VAULT, blind: ["chat.newtool.ai"] });
const branch = (tree, key) => tree.children.find((b) => b.key === key);

test("model: what each AI has counts sent, just counted and reply mentions; near misses count hidden", () => {
  const m = model();
  const has = Object.fromEntries(m.has.bySite.map((s) => [s.key, s.count]));
  assert.deepEqual(has, { "chatgpt.com": 3, "claude.ai": 1, "gemini.google.com": 1 });
  assert.equal(m.has.bySite.find((s) => s.key === "claude.ai").severity, "high");
  assert.deepEqual(
    m.near.bySite.map((s) => [s.key, s.count]),
    [["claude.ai", 1]],
  );
  assert.deepEqual(
    m.mentioned.bySite.map((s) => s.key),
    ["gemini.google.com"],
  );
});

test("model: not shared yet = vault details no AI has seen (fine-to-share and sent ones excluded)", () => {
  const open = Object.fromEntries(model().open.map((o) => [o.key, o.count]));
  assert.deepEqual(open, { street_address: 2, family_name: 1 });
});

test("tree: four branches in both views, even with no history", () => {
  for (const view of ["service", "kind"]) {
    const empty = buildMindMapTree(exposureModel({}), { view });
    assert.deepEqual(
      empty.children.map((b) => b.key),
      ["has", "near", "open", "blind"],
    );
    const cantSee = branch(empty, "blind").children.find((c) => c.type === "cant-see");
    assert.equal(cantSee.children.length, 3, "desktop apps, phone apps, browser side panels");
  }
});

test("tree: the toggle regroups by AI service or by kind", () => {
  const byService = buildMindMapTree(model(), { view: "service" });
  const has = branch(byService, "has");
  assert.deepEqual(
    has.children.map((c) => [c.type, c.key]),
    [
      ["service", "chatgpt.com"],
      ["service", "claude.ai"],
      ["service", "gemini.google.com"],
    ],
  );
  const chatgpt = has.children[0];
  assert.deepEqual(
    chatgpt.children.map((l) => [l.label, l.count]),
    [
      ["Phone Number", 2],
      ["Email Address", 1],
    ],
  );
  assert.equal(has.children[2].mentioned, 1, "gemini's reply brought up your name");

  const byKind = buildMindMapTree(model(), { view: "kind" });
  const phone = branch(byKind, "has").children.find((c) => c.key === "phone_number");
  assert.equal(phone.type, "kind");
  assert.deepEqual(
    phone.children.map((l) => [l.label, l.count]),
    [["chatgpt.com", 2]],
  );
});

test("tree: a crowded branch collapses into +N more", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    ev(`ai${String(i).padStart(2, "0")}.example`, "email", "allowed"),
  );
  const has = branch(buildMindMapTree(exposureModel({ events }), { max: 8 }), "has");
  assert.equal(has.children.length, 8);
  const more = has.children.at(-1);
  assert.equal(more.type, "more");
  assert.equal(more.label, "+5 more");
  assert.equal(more.count, 5);
  assert.equal(more.branch, "has", "drawn in its branch's style (it broke the by-kind view)");
});

test("tree, compact (popup): only branches with something, no leaves, no can't-see branch", () => {
  const tree = buildMindMapTree(exposureModel({ events: EVENTS }), { compact: true });
  assert.deepEqual(
    tree.children.map((b) => b.key),
    ["has", "near"],
  );
  for (const b of tree.children) for (const c of b.children) assert.equal(c.children.length, 0);
});

test("never a value: the tree holds kinds, sites and counts only", () => {
  const text = JSON.stringify(buildMindMapTree(model()), (k, v) => (v instanceof Map ? [...v] : v));
  for (const fp of ["a000000000000001", "c000000000000001", "b000000000000001"]) assert.ok(!text.includes(fp));
});

test("layout: every node gets a finite slice; children split their parent's slice in order", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const check = (n) => {
    assert.ok(Number.isFinite(n.angle) && n.a1 > n.a0, `${n.id} has a slice`);
    let a = n.a0;
    for (const c of n.children) {
      assert.equal(c.depth, n.depth + 1);
      assert.ok(Math.abs(c.a0 - a) < 1e-9, `${c.id} starts where its sibling ended`);
      assert.ok(c.a1 <= n.a1 + 1e-9, `${c.id} stays inside ${n.id}`);
      a = c.a1;
      check(c);
    }
    if (n.children.length) assert.ok(Math.abs(a - n.a1) < 1e-9, `${n.id}'s children fill its slice`);
  };
  check(tree);
  assert.ok(Math.abs(tree.a1 - tree.a0 - 2 * Math.PI) < 1e-9, "the whole circle");
});

test("layout: a busy branch gets a wider slice than an empty one", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const span = (key) => branch(tree, key).a1 - branch(tree, key).a0;
  assert.ok(span("has") > span("near"));
});

test("table view: one row per service, kind, spotted site and the can't-see entry", () => {
  const rows = mindMapRows(buildMindMapTree(model()));
  const blind = rows.filter((r) => r.branch === "Blind spots");
  assert.deepEqual(
    blind.map((r) => r.what),
    ["chat.newtool.ai", "Clotr can't see"],
  );
  assert.match(blind[1].detail, /AI apps on your computer/);
  assert.ok(rows.some((r) => r.branch === "Not shared yet" && r.count === "2"));
});

test("layout: every branch around You gets at least its minimum share of the circle", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  for (const b of tree.children) assert.ok(b.a1 - b.a0 >= 0.14 * 2 * Math.PI - 1e-9, `${b.key} is squeezed`);
});

test("outline layout (narrow windows): one row per node, children indented under their parent", () => {
  const { layoutList } = globalThis.ClotrMindMap;
  const tree = layoutList(buildMindMapTree(model(), { leaves: false }));
  assert.equal(tree.layout, "list");
  const ys = [];
  const check = (n) => {
    ys.push(n.y);
    for (const c of n.children) {
      assert.ok(c.x > n.x && c.y > n.y, `${c.id} sits below and to the right of ${n.id}`);
      check(c);
    }
  };
  check(tree);
  assert.equal(new Set(ys).size, ys.length, "no two nodes share a row");
});

// The drawing's layout (mindMapLayout): places, lines, shapes, labels and the frame, without a browser.
const ROOM = { width: 960, height: 690 };
const nodesOf = (n) => [n, ...n.children.flatMap(nodesOf)];
const byId = (items) => new Map(items.map((i) => [i.node.id, i]));
// A hand-made radial tree: You, one branch, and AI services at chosen angles.
const handMade = (services, { branch = "has" } = {}) => ({
  id: "you",
  type: "you",
  label: "You",
  count: 0,
  layout: "radial",
  depth: 0,
  angle: 0,
  children: [
    {
      id: branch,
      type: "branch",
      branch,
      key: branch,
      label: "Already has",
      count: services.length,
      depth: 1,
      angle: 0,
      children: services.map(([label, angle, extra = {}]) => ({
        id: `${branch}/${label}`,
        type: "service",
        branch,
        key: label,
        label,
        count: 1,
        severity: "medium",
        depth: 2,
        angle,
        children: [],
        ...extra,
      })),
    },
  ],
});

test("drawing layout: You in the middle, then every other node once, each after its parent", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const { you, items } = mindMapLayout(tree, ROOM);
  assert.deepEqual(you, { x: 480, y: 345, r: 24 });
  assert.deepEqual(
    items.map((i) => i.node.id),
    nodesOf(tree)
      .slice(1)
      .map((n) => n.id),
  );
  const drawn = new Set([tree.id]);
  for (const i of items) {
    assert.ok(drawn.has(i.parent.id), `${i.node.id} comes before its parent`);
    drawn.add(i.node.id);
  }
});

test("drawing layout: every line runs from its parent's place to its own, and every place is inside the room", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const { you, items } = mindMapLayout(tree, ROOM);
  const placeOf = new Map([[tree.id, [you.x, you.y]], ...items.map((i) => [i.node.id, [i.x, i.y]])]);
  for (const i of items) {
    assert.deepEqual(i.line.from, placeOf.get(i.parent.id), `${i.node.id}'s line starts at its parent`);
    assert.deepEqual(i.line.to, [i.x, i.y], `${i.node.id}'s line ends at it`);
    assert.ok(i.x > 0 && i.x < ROOM.width && i.y > 0 && i.y < ROOM.height, `${i.node.id} is outside the room`);
  }
});

test("drawing layout: each node sits further out than its parent, on its own slice's side of You", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const { you, items } = mindMapLayout(tree, ROOM);
  const far = (x, y) => Math.hypot((x - you.x) / ROOM.width, (y - you.y) / ROOM.height);
  for (const i of items) {
    assert.ok(far(i.x, i.y) > far(...i.line.from), `${i.node.id} is no further out than its parent`);
    const c = Math.cos(i.node.angle);
    if (Math.abs(c) > 0.01) assert.equal(Math.sign(i.x - you.x), Math.sign(c), `${i.node.id} is on the wrong side`);
  }
});

test("drawing layout: pills for branches, rings for AI services and kinds, dots for leaves; busier lines are thicker, up to a cap", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const { items } = mindMapLayout(tree, ROOM);
  for (const i of items) {
    const n = i.node;
    if (n.type === "branch") {
      assert.deepEqual(
        [i.shape.type, i.shape.name, i.shape.count, i.label],
        ["pill", n.label, String(n.count), null],
        `${n.id}: a pill with its name and count, no label beside it`,
      );
      assert.ok(i.shape.width > (n.label.length + 2) * 6, `${n.id}'s pill is too narrow for its words`);
    } else if (n.type === "leaf" || n.type === "more") {
      assert.deepEqual([i.shape.type, i.line.width], ["dot", 1], `${n.id}: a dot on a thin line`);
      assert.ok(i.label.text.startsWith(n.label.slice(0, 10)), `${n.id}'s label`);
    } else {
      assert.equal(i.shape.type, "ring", n.id);
      assert.equal(i.shape.mark, n.type === "cant-see" ? "?" : n.count ? String(n.count) : "", `${n.id}'s mark`);
    }
    assert.ok(i.line.width >= 1 && i.line.width <= 6.5, `${n.id}'s line width ${i.line.width}`);
  }
  const has = items.filter((i) => i.node.branch === "has" && i.node.type === "service");
  const [busy, quiet] = [...has].sort((a, b) => b.node.count - a.node.count).map((i) => i.line.width);
  assert.ok(busy > quiet, "the AI service with more details doesn't get a thicker line");
  const many = mindMapLayout(handMade([["a.ai", 0, { count: 40 }]]), ROOM).items[1];
  assert.equal(many.line.width, 6.5, "line width isn't capped");
});

test("drawing layout, compact (popup): branches are junction dots, smaller rings and a smaller You", () => {
  const tree = layoutRadial(buildMindMapTree(model(), { compact: true, max: 4 }));
  const { you, items } = mindMapLayout(tree, { width: 300, height: 220, compact: true });
  assert.equal(you.r, 14);
  for (const i of items) {
    if (i.node.type === "branch") assert.deepEqual([i.shape.type, i.label], ["junction", null], i.node.id);
    else assert.deepEqual([i.shape.type, i.shape.r], ["ring", 10], i.node.id);
  }
});

test("drawing layout: a label sits on its node's outer side (above or below when the node is straight up or down)", () => {
  const tree = handMade([
    ["right.ai", 0],
    ["left.ai", Math.PI],
    ["up.ai", -Math.PI / 2],
    ["down.ai", Math.PI / 2],
  ]);
  const at = byId(mindMapLayout(tree, ROOM).items);
  const label = (id) => at.get(`has/${id}`).label;
  assert.equal(label("right.ai").anchor, "start");
  assert.ok(label("right.ai").x > 15, "a label on the right starts after its ring");
  assert.equal(label("left.ai").anchor, "end");
  assert.ok(label("left.ai").x < -15, "a label on the left ends before its ring");
  assert.deepEqual([label("up.ai").anchor, label("up.ai").x], ["middle", 0]);
  assert.ok(label("up.ai").y < -15, "a label straight up sits above its ring");
  assert.ok(label("down.ai").y > 15, "a label straight down sits below its ring");
});

test("drawing layout: long names are cut short with …; www. is dropped; a reply mention adds 💬", () => {
  const long = "a-very-long-ai-service-name-that-goes-on.example";
  const tree = handMade([
    [long, 0],
    ["www.short.ai", Math.PI, { mentioned: 1 }],
  ]);
  const at = byId(mindMapLayout(tree, ROOM).items);
  const text = at.get(`has/${long}`).label.text;
  assert.equal(text.length, 18, "two rings: up to 18 characters");
  assert.ok(text.endsWith("…") && long.startsWith(text.slice(0, -1)), text);
  assert.equal(at.get("has/www.short.ai").label.text, "short.ai 💬");
  const leafy = layoutRadial(buildMindMapTree(model()));
  for (const i of mindMapLayout(leafy, ROOM).items)
    if (i.label) assert.ok(i.label.text.length <= (i.shape.type === "dot" ? 36 : 26), i.label.text);
});

test("drawing layout: the frame holds every node and label, and widens for a long name", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const { you, items, frame } = mindMapLayout(tree, ROOM);
  const [fx, fy, fw, fh] = frame;
  const inside = (x, y) => x >= fx && x <= fx + fw && y >= fy && y <= fy + fh;
  assert.ok(inside(you.x - you.r, you.y - you.r) && inside(you.x + you.r, you.y + you.r), "You is outside the frame");
  for (const i of items) {
    assert.ok(inside(i.x, i.y), `${i.node.id} is outside the frame`);
    if (i.label) assert.ok(inside(i.x + i.label.x, i.y + i.label.y), `${i.node.id}'s label is outside the frame`);
  }
  const width = (name) => mindMapLayout(handMade([[name, 0]]), ROOM).frame[2];
  assert.ok(width("a-much-longer-name.ai") > width("b.ai"), "a longer label doesn't widen the frame");
});

test("drawing layout, outline (narrow windows): places from the outline, lines down then across, pills start at their line", () => {
  const { layoutList } = globalThis.ClotrMindMap;
  const tree = layoutList(buildMindMapTree(model(), { leaves: false }));
  const { you, items } = mindMapLayout(tree, { width: 400, height: 400 });
  assert.deepEqual([you.x, you.y], [tree.x, tree.y]);
  for (const i of items) {
    assert.deepEqual([i.x, i.y], [i.node.x, i.node.y], i.node.id);
    assert.deepEqual(i.line.via, [i.line.from[0], i.y], `${i.node.id}: the line turns below its parent`);
    if (i.shape.type === "pill") assert.equal(i.x + i.shape.shift - i.shape.width / 2, i.x - 12, i.node.id);
    if (i.label) assert.equal(i.label.anchor, "start", `${i.node.id}'s label reads to the right`);
  }
});

test("drawing layout is pure: the tree is left as it was, and the same tree gives the same layout", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const text = (t) => JSON.stringify(t, (k, v) => (v instanceof Map ? [...v] : v));
  const before = text(tree);
  const a = mindMapLayout(tree, ROOM);
  assert.equal(text(tree), before);
  assert.deepEqual(mindMapLayout(tree, ROOM), a);
});

test("blind spots: spotted AI sites Clotr doesn't protect at all (a protected section of a site counts as protected)", () => {
  const { unprotectedHosts } = globalThis.ClotrInsights;
  const covered = ["https://chatgpt.com/*", "https://huggingface.co/chat/*", "https://huggingface.co/spaces/x/*"];
  assert.deepEqual(
    unprotectedHosts({ "chat.newtool.ai": true, "chatgpt.com": true, "huggingface.co": true }, covered),
    ["chat.newtool.ai"],
  );
  assert.deepEqual(unprotectedHosts({}, covered), []);
  assert.deepEqual(unprotectedHosts(null, covered), []);
});
