// The vault's word on a found value takes that value's strong fingerprint (about 15 ms, slow on purpose), so a
// pasted list of hundreds of details once froze the chat tab for anyone who had saved a detail of that kind.
// These hold the two fixes in decide.js: a value is only looked up when the vault could change its answer, and a
// host's time budget per check leaves the rest for later, never quieter than the full answer would be.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestOfBoth } = require("./timing");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
const C = globalThis.Clotr;

const SALT = "0123456789abcdef0123456789abcdef";
const state = (extra = {}) => ({ salt: SALT, vault: [], responses: {}, siteMode: null, cache: new Map(), ...extra });
// `as` is the kind the fingerprint was made as: an address saved before 0.9.68 is stored as a street address but
// fingerprinted with its accents ("street_address_accented").
const strong = (type, value, mode, as = type) => ({
  kind: "value",
  type,
  fp: C.fingerprintStrong(SALT, as, value),
  scheme: 2,
  mode,
  added: 1,
});
const weak = (type, value, mode, as = type) => ({
  kind: "value",
  type,
  fp: C.fingerprint(SALT, as, value),
  mode,
  added: 1,
});
const found = (id, matches, extra = {}) => ({ id, name: id, severity: "medium", matches, ...extra });
const phones = (n) => Array.from({ length: n }, (_, i) => `555-${200 + Math.floor(i / 10)}-${1000 + i}`);
const emails = (n) => Array.from({ length: n }, (_, i) => `jane.doe${i}@corp-mail.com`);

// What decide.js answered before this fix, rebuilt here so the comparison still proves the point if the real
// functions change underneath it: every value looked up in the vault, however long it took.
function oldVaultMode(patternId, match, s) {
  const entries = s.vault || [];
  if (!s.salt || !entries.some((e) => e.kind === "value")) return null;
  const entry = (id) =>
    entries
      .filter((e) => e.kind === "value" && e.type === patternId)
      .find((e) => e.fp === C.fingerprintFor(e.scheme === 2 ? 2 : undefined, s.salt, id, match));
  const hit =
    entry(patternId) ||
    (patternId === "street_address" && /[^\x00-\x7f]/.test(match) && entry("street_address_accented"));
  return hit?.mode || null;
}
function oldRespFor(r, m, s) {
  const mode = oldVaultMode(r.id, m, s);
  if (mode === "allow") return "log";
  const base = C.responseOf(r.id, s);
  return mode === "protect" && base === "log" ? "warn" : base;
}
const RANK = { log: 0, warn: 1, block: 2 };

test("respFor: 600 phone numbers with a saved phone to protect are decided in well under a second", () => {
  const r = found("phone_number", phones(600));
  const savedPhone = strong("phone_number", "(555) 555-5636", "protect");
  let answers;
  const timing = bestOfBoth(() => {
    const s = state({ vault: [savedPhone] });
    answers = r.matches.map((m) => C.respFor(r, m, s));
  });
  assert.ok(answers.every((a) => a === "warn"));
  // Before the fix: 600 strong fingerprints, about 9 seconds.
  assert.ok(!timing.over(500), `took ${Math.round(timing.wall)} ms`);
});

test("respFor: 600 emails with a saved email marked OK to share stay within a host's time budget", () => {
  const mine = "jo@example.org";
  const list = [...emails(599), mine];
  const r = found("email", list);
  const savedEmail = strong("email", mine, "allow");
  let s;
  let answers;
  const timing = bestOfBoth(() => {
    s = state({ vault: [savedEmail] });
    s.budget = { until: performance.now() + 50, missed: [] };
    answers = r.matches.map((m) => C.respFor(r, m, s));
  });
  // One slow fingerprint can start just before the budget ends; anything past that is left for later.
  assert.ok(!timing.over(50 + 100), `took ${Math.round(timing.wall)} ms with a 50 ms budget`);
  assert.ok(s.budget.missed.length > 500, `only ${s.budget.missed.length} left for later`);
  // Not known yet means the kind's usual warning, so the saved email is warned about until it's worked out.
  assert.equal(answers.at(-1), "warn");
  // The host works out what was left (no budget this time), and the next check has the full answer.
  const later = s.budget.missed.filter(([, m]) => m === mine || m === list[0]);
  delete s.budget;
  for (const [id, m] of later) C.vaultMode(id, m, s);
  assert.equal(C.respFor(r, mine, s), "log");
  assert.equal(C.respFor(r, list[0], s), "warn");
});

test("respFor and splitOwnIds: the same answers as before for every vault, kind, response and value", () => {
  // Fast (scheme 1) entries keep this quick; a few strong ones show both schemes behave alike.
  const kinds = ["phone_number", "email", "street_address", "my_id", "license_plate", "us_ssn"];
  const values = {
    phone_number: ["555-555-5636", "(555) 555-5636", "555-555-1234", "+1 555 555 9999"],
    email: ["jo@example.org", "JO@example.org", "bob@gmail.com"],
    street_address: ["Calle Alcalá 45", "calle alcala 45", "12 Main Street"],
    my_id: ["EMP-48213", "emp-48213", "EMP-11111"],
    license_plate: ["ABC 1234", "abc-1234", "XYZ 9"],
    us_ssn: ["123-45-6789", "987-65-4321"],
  };
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (a) => a[rand(a.length)];
  let compared = 0;
  for (let round = 0; round < 300; round++) {
    const vault = [];
    for (let i = rand(4); i > 0; i--) {
      const kind = pick(kinds);
      const as = kind === "street_address" && rand(3) === 0 ? "street_address_accented" : kind;
      const make = rand(8) === 0 ? strong : weak;
      vault.push(make(kind, pick(values[kind]), pick(["protect", "allow", undefined]), as));
    }
    if (rand(6) === 0) vault.push({ kind: "word", type: "watch_list", fp: "0123456789abcdef", added: 1 });
    const responses = {};
    for (const k of kinds) if (rand(2)) responses[k] = pick(["block", "warn", "log"]);
    const s = state({ vault, responses, siteMode: pick([null, null, "block", "log"]), salt: rand(10) ? SALT : null });
    for (const kind of kinds) {
      const r = found(kind, values[kind]);
      for (const m of r.matches) {
        assert.equal(C.respFor(r, m, s), oldRespFor(r, m, s), `${kind} ${JSON.stringify(vault)}`);
        compared++;
      }
    }
    const ids = found("my_id", values.my_id, { severity: "high" });
    const split = C.splitOwnIds([ids], s);
    const own = (m) => oldVaultMode("my_id", m, s) !== null;
    const hasId = s.salt && vault.some((e) => e.kind === "value" && e.type === "my_id");
    assert.deepEqual(
      split.map((x) => x.matches),
      hasId ? [values.my_id.filter(own), values.my_id.filter((m) => !own(m))].filter((x) => x.length) : [values.my_id],
    );
  }
  assert.ok(compared > 3000, `only ${compared} compared`);
});

test("respFor: under a spent time budget, never quieter than the full answer", () => {
  const vaults = [
    [strong("phone_number", "555-555-5636", "allow")],
    [strong("license_plate", "ABC 1234", "protect")],
    [strong("phone_number", "555-555-5636", "protect"), strong("license_plate", "ABC 1234", "allow")],
  ];
  const cases = [
    ["phone_number", ["555-555-5636", "555-555-1234"]],
    ["license_plate", ["ABC 1234", "XYZ 9"]],
  ];
  for (const vault of vaults) {
    for (const responses of [{}, { phone_number: "log" }, { license_plate: "warn" }, { phone_number: "block" }]) {
      for (const [id, matches] of cases) {
        const r = found(id, matches);
        for (const m of matches) {
          const full = C.respFor(r, m, state({ vault, responses }));
          const spent = state({ vault, responses, budget: { until: -1, missed: [] } });
          const now = C.respFor(r, m, spent);
          assert.ok(RANK[now] >= RANK[full], `${id} ${m}: ${now} under the budget, ${full} in full`);
        }
      }
    }
  }
});

test("splitOwnIds: an ID not worked out yet counts as yours, so it keeps the higher rank", () => {
  const s = state({ vault: [strong("my_id", "EMP-48213", "protect")], budget: { until: -1, missed: [] } });
  const ids = found("my_id", ["EMP-48213", "EMP-11111"], { severity: "high" });
  assert.deepEqual(C.splitOwnIds([ids], s), [ids]);
  assert.ok(s.budget.missed.length >= 2);
});

test("vaultMode: a spent budget never defers a value only fast (old scheme) entries could match", () => {
  const s = state({ vault: [weak("phone_number", "555-555-5636", "allow")], budget: { until: -1, missed: [] } });
  assert.equal(C.vaultMode("phone_number", "555-555-5636", s), "allow");
  assert.deepEqual(s.budget.missed, []);
});
