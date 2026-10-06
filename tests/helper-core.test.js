// When an update adds a new kind of personal detail, this keeps the "ask before sending personal details"
// switch on if it already was. Only the kinds the update just added follow that switch. A kind the person
// already knew keeps whatever they'd chosen, and someone who only had a few kinds set to ask gets nothing new.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/helper-core.js");
const { Helper, PATTERNS } = globalThis.Clotr;

const PERSONAL = Helper.PERSONAL_IDS;
const ask = (ids) => Object.fromEntries(ids.map((id) => [id, "block"]));
// Pretend this copy is from before the update: it knew every kind except the last two personal ones.
const NEW = PERSONAL.slice(-2);
const KNOWN = PATTERNS.map((p) => p.id).filter((id) => !NEW.includes(id));
const KNOWN_PERSONAL = PERSONAL.filter((id) => !NEW.includes(id));

test("personal switch: with it on, the kinds an update brings ask first too, and the switch reads on", () => {
  const responses = ask(KNOWN_PERSONAL);
  assert.ok(!Helper.asksBeforePersonal(responses), "the switch should read off before the rule");
  const fresh = Helper.newPersonalToAsk(responses, KNOWN);
  assert.deepEqual(fresh, NEW);
  assert.ok(Helper.asksBeforePersonal({ ...responses, ...ask(fresh) }), "the switch should read on after it");
});

test("personal switch: a new kind with a choice of its own keeps it", () => {
  const responses = { ...ask(KNOWN_PERSONAL), [NEW[0]]: "warn" };
  assert.deepEqual(Helper.newPersonalToAsk(responses, KNOWN), [NEW[1]]);
});

test("personal switch: off, changed, or only a few kinds asking: nothing new asks", () => {
  // The switch was off the whole time.
  assert.deepEqual(Helper.newPersonalToAsk({}, KNOWN), []);
  // The switch was on, then someone turned one kind back to warn by hand.
  assert.deepEqual(Helper.newPersonalToAsk({ ...ask(KNOWN_PERSONAL), [KNOWN_PERSONAL[0]]: "warn" }, KNOWN), []);
  // Setting a few kinds to ask one by one, leaving the rest untouched, doesn't count as the switch.
  assert.deepEqual(Helper.newPersonalToAsk(ask(KNOWN_PERSONAL.slice(0, 3)), KNOWN), []);
  // Other kinds don't move this. A password set to ask isn't the personal switch.
  assert.deepEqual(Helper.newPersonalToAsk({ password: "block" }, KNOWN), []);
});

test("personal switch: nothing new, nothing changes", () => {
  assert.deepEqual(
    Helper.newPersonalToAsk(
      ask(PERSONAL),
      PATTERNS.map((p) => p.id),
    ),
    [],
  );
  assert.deepEqual(
    Helper.newPersonalToAsk(
      ask(KNOWN_PERSONAL),
      PATTERNS.map((p) => p.id),
    ),
    [],
  );
});

// A copy updated from before Clotr tracked its own list of known kinds (1.2.0 or earlier) is treated as having
// known everything 1.2.0 did.
test("personal switch: without a list of known kinds, the kinds of 1.2.0 count as known", () => {
  const base = Helper.PERSONAL_IDS_1_2;
  assert.equal(base.length, 18);
  for (const id of base) assert.ok(PERSONAL.includes(id), `${id} is no longer a personal kind`);
  const brought = PERSONAL.filter((id) => !base.includes(id));
  for (const known of [undefined, null, "everything", [1, 2]])
    assert.deepEqual(Helper.newPersonalToAsk(ask(base), known), brought, `known: ${JSON.stringify(known)}`);
  assert.deepEqual(Helper.newPersonalToAsk(ask(base.slice(1)), undefined), []);
});
