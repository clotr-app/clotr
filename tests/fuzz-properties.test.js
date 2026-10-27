// Property-based fuzzing for the engine, on top of the seeded generator in tests/fuzz.test.js. fast-check builds
// its own random inputs from the arbitraries below and shrinks any failure to the smallest string that still
// breaks the property, so a crash here points straight at the cause instead of a 400-character paste.
// Run from the repo root: node --test tests/fuzz-properties.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("fast-check");
const { bestOfPair, grewMoreThan } = require("./timing.js");
const { SECRET_KINDS, EXTRA_KINDS, makeSecrets } = require("./fixtures/secrets.js");

require("../extension/patterns.js");
require("../extension/detector.js");

const SEVERITIES = new Set(["high", "medium", "low"]);
const { generatedCases, secretPatterns, wrappersFor } = require("./fuzz/structure.js");

// The same shape tests/patterns.test.js and tests/fuzz.test.js expect of every finding: a real id and severity, a
// name, and a non-empty list of matches that are each a genuine, non-empty piece of the exact text passed in.
function wellFormed(results, text) {
  if (!Array.isArray(results)) return false;
  for (const r of results) {
    if (typeof r.id !== "string" || !r.id) return false;
    if (!SEVERITIES.has(r.severity)) return false;
    if (typeof r.name !== "string" || !r.name) return false;
    if (!Array.isArray(r.matches) || r.matches.length === 0) return false;
    for (const m of r.matches) {
      if (typeof m !== "string" || !m) return false;
      const at = text.indexOf(m);
      if (at < 0 || at + m.length > text.length) return false;
    }
  }
  return results.truncated === undefined || typeof results.truncated === "boolean";
}

// Order-independent, so a run that found the same things in a different order still compares equal.
const resultShape = (results) =>
  [...results]
    .map((r) => ({ id: r.id, matches: [...r.matches].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// Any string fast-check can build: full Unicode, including lone surrogates and invisible characters, up to a
// length long enough to exercise real patterns without making every run of the suite slow.
const arbitraryText = fc.string({ unit: "binary", maxLength: 2000 });

const detect = (t) => globalThis.Clotr.detect(t);

const FIXTURE_SEEDS = [7, 42, 20261019, 20261020];
const fixtureCache = new Map();
function fixtureFor(seed, kind) {
  if (!fixtureCache.has(seed)) fixtureCache.set(seed, makeSecrets(seed));
  return fixtureCache.get(seed).find((fixture) => fixture.kind === kind);
}

const CASES = makeSecrets(20261019).flatMap((fixture) => fixture.shapes.map((shape) => [fixture.kind, shape.name]));
const seededCase = fc
  .tuple(fc.constantFrom(...FIXTURE_SEEDS), fc.constantFrom(...CASES))
  .map(([seed, [kind, shapeName]]) => ({ seed, kind, shapeName }));

function caseFrom(seed, kind, shapeName) {
  const fixture = fixtureFor(seed, kind);
  return { fixture, shape: fixture.shapes.find((shape) => shape.name === shapeName) };
}

const residualRun = (secret, output, min = 12) => {
  const normalize = (value) =>
    value
      .replace(/\[REDACTED [^\]]*\]/g, "")
      .replace(/\b(?:PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|SECRET|TOKEN)\s*[:=]\s*/gi, "")
      .replace(/[\s"'\\]/g, "");
  const body = normalize(secret);
  const left = normalize(output);
  for (let i = 0; i + min <= body.length; i++) if (left.includes(body.slice(i, i + min))) return body.slice(i, i + min);
  return "";
};

function expectFindingsCover(fixture, shape) {
  assert.ok(!shape.ratchet, "every fixture shape must pass");
  const results = detect(shape.text);
  const hit = new Uint8Array(shape.text.length);
  for (const result of results) {
    for (const match of result.matches) {
      assert.ok(shape.text.includes(match), `${result.id}: match is not a substring of the raw paste`);
      for (let at = shape.text.indexOf(match); at >= 0; at = shape.text.indexOf(match, at + 1)) {
        hit.fill(1, at, at + match.length);
      }
      assert.ok(
        shape.contextual || detect(match).some((other) => other.id === result.id),
        `${result.id}: match does not stand alone`,
      );
    }
  }
  let occurrences = 0;
  for (let at = shape.text.indexOf(shape.value); at >= 0; at = shape.text.indexOf(shape.value, at + 1)) {
    occurrences++;
    for (let i = 0; i < shape.value.length; i++) {
      if (/\s/.test(shape.value[i])) continue;
      assert.equal(hit[at + i], 1, `${fixture.kind}:${shape.name}: secret character ${i} is outside every finding`);
    }
  }
  assert.ok(occurrences, `${fixture.kind}:${shape.name}: planted secret is not in its paste`);
}

test("property: detect() never throws on any string", () => {
  fc.assert(
    fc.property(arbitraryText, (t) => {
      detect(t);
    }),
  );
});

test("property: every finding detect() returns is well formed", () => {
  fc.assert(
    fc.property(arbitraryText, (t) => {
      assert.ok(wellFormed(detect(t), t));
    }),
  );
});

test("property: detect() agrees with itself on the same text", () => {
  fc.assert(
    fc.property(arbitraryText, (t) => {
      assert.deepEqual(resultShape(detect(t)), resultShape(detect(t)));
    }),
  );
});

test("property: detect() grows with an ordinary paste", () => {
  fc.assert(
    fc.property(arbitraryText, (t) => {
      const unit = t || "x";
      const make = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const [small, big] = bestOfPair(
        () => detect(make(512)),
        () => detect(make(2048)),
        4,
        3,
      );
      assert.ok(!grewMoreThan(small, big, 16), "time grew too much for 4× the text");
    }),
    { numRuns: 15 },
  );
});

test("secret fixtures include the detector kinds that share a finding", () => {
  const fixtures = makeSecrets(20261019);
  const kinds = new Set(fixtures.map((fixture) => fixture.kind));
  for (const kind of [...SECRET_KINDS, ...EXTRA_KINDS]) assert.ok(kinds.has(kind), `${kind} has no fixture`);
  assert.ok(fixtures.every((fixture) => fixture.shapes.every((shape) => !shape.ratchet)));
});

test("property: Cover it and generalize leave no 12-character run of each planted secret", () => {
  for (const fixture of makeSecrets(20261019)) {
    for (const shape of fixture.shapes) {
      assert.ok(!shape.ratchet, fixture.kind + ":" + shape.name + " cannot be left on the ratchet");
      const results = detect(shape.text);
      const found = results.some((result) => result.id === fixture.kind);
      const redacted = globalThis.Clotr.redact(shape.text, results);
      const generalized = globalThis.Clotr.generalize(shape.text, results, "en-US");
      const residues = [redacted, generalized].map((out) => residualRun(shape.value, out)).filter(Boolean);
      const key = fixture.kind + ":" + shape.name;
      assert.ok(found, `${key}: no finding for the planted secret`);
      assert.deepEqual(residues, [], `${key}: a 12-character run remains after Cover it`);
    }
  }
  fc.assert(
    fc.property(seededCase, ({ seed, kind, shapeName }) => {
      const { fixture, shape } = caseFrom(seed, kind, shapeName);
      const results = detect(shape.text);
      const found = results.some((result) => result.id === fixture.kind);
      const key = fixture.kind + ":" + shape.name;
      const residues = [
        globalThis.Clotr.redact(shape.text, results),
        globalThis.Clotr.generalize(shape.text, results, "en-US"),
      ].map((out) => residualRun(shape.value, out));
      assert.ok(found, `${key}: no finding for the planted secret`);
      assert.deepEqual(residues, ["", ""], `${key}: a 12-character run remains after Cover it`);
    }),
    { numRuns: 120, seed: 20261019 },
  );
});

const STRUCTURE_DEEP = process.env.CLOTR_FUZZ_DEEP === "1";
const STRUCTURE_SEEDS = Array.from({ length: STRUCTURE_DEEP ? 20 : 1 }, (_, index) => 20261020 + index);
const STRUCTURE_TIMEOUT = STRUCTURE_DEEP ? 180_000 : 20_000;

test("property: structure-aware fuzz leaves no 12-character run after Cover it", { timeout: STRUCTURE_TIMEOUT }, () => {
  const expectedKinds = new Set([
    ...secretPatterns().map((pattern) => pattern.id),
    "private_key",
    "crypto_secret",
    "connection_string",
  ]);
  let cases = 0;
  for (const seed of STRUCTURE_SEEDS) {
    for (const candidate of generatedCases(seed)) {
      assert.ok(expectedKinds.has(candidate.kind), `${candidate.kind}; seed=${seed}`);
      for (const form of wrappersFor(candidate)) {
        const findings = detect(form.text);
        if (form.detect) {
          assert.ok(
            findings.length > 0,
            `${candidate.kind}:${candidate.name}:${form.name} was not found; seed=${seed}`,
          );
        }
        const redacted = globalThis.Clotr.redact(form.text, findings);
        assert.equal(
          residualRun(candidate.value, redacted),
          "",
          `${candidate.kind}:${candidate.name}:${form.name} left a 12-character run; seed=${seed}`,
        );
        cases++;
      }
    }
  }
  assert.ok(cases > 0, "the structure-aware generator produced no cases");
  console.log(
    `[fuzz-structure] ${cases} wrapped secrets across ${STRUCTURE_SEEDS.length} seed(s): ${STRUCTURE_SEEDS.join(", ")}`,
  );
});

test("property: two different secrets are gone in both paste orders", () => {
  const pairKinds = fc
    .tuple(fc.constantFrom(...SECRET_KINDS), fc.constantFrom(...SECRET_KINDS))
    .filter(([left, right]) => left !== right);
  fc.assert(
    fc.property(
      pairKinds,
      fc.constantFrom(...FIXTURE_SEEDS),
      fc.constantFrom(...FIXTURE_SEEDS),
      ([aKind, bKind], aSeed, bSeed) => {
        const a = fixtureFor(aSeed, aKind);
        const b = fixtureFor(bSeed, bKind);
        for (const [urlSecret, envSecret] of [
          [a, b],
          [b, a],
        ]) {
          const text = `DATABASE_URL=postgres://app:${urlSecret.value}@db-demo.corp-demo.net:5432/app\n${envSecret.kind.toUpperCase()}=${envSecret.value}`;
          const output = globalThis.Clotr.redact(text, detect(text));
          for (const secret of [a, b]) {
            assert.equal(
              residualRun(secret.value, output),
              "",
              `${secret.kind} survives with ${urlSecret.kind} in the URL password and ${envSecret.kind} in the .env line`,
            );
          }
        }

        for (const [first, second] of [
          [a, b],
          [b, a],
        ]) {
          const text = `${first.kind.toUpperCase()}=${first.value}\n${second.kind.toUpperCase()}=${second.value}`;
          const output = globalThis.Clotr.redact(text, detect(text));
          for (const secret of [first, second]) {
            assert.equal(
              residualRun(secret.value, output),
              "",
              `${secret.kind} survives beside ${first.kind} in a two-key .env paste`,
            );
          }
        }

        const pem = fixtureFor(aSeed, "private_key");
        for (const text of [
          `The ${a.kind} is ${a.value}. The private key block follows:\n${pem.value}`,
          `${pem.value}\nThe ${a.kind} is ${a.value}.`,
        ]) {
          const output = globalThis.Clotr.redact(text, detect(text));
          for (const secret of [a, pem]) {
            assert.equal(
              residualRun(secret.value, output),
              "",
              `${secret.kind} survives with the other secret in prose and a PEM block`,
            );
          }
        }

        const password = fixtureFor(aSeed, "aws_access_key");
        const connection = `https://app:${password.value}@s3.corp-demo.net/bucket`;
        const nested = `DATABASE_URL=${connection}`;
        const nestedOutput = globalThis.Clotr.redact(nested, detect(nested));
        assert.equal(residualRun(connection, nestedOutput), "", "the complete connection string should be covered");
        assert.equal(residualRun(password.value, nestedOutput), "", "the key in the URL password should be covered");
      },
    ),
    { numRuns: 120, seed: 20261020 },
  );
});

test("property: each finding maps to raw text, covers its planted secret, and stands alone", () => {
  for (const fixture of makeSecrets(20261019)) {
    for (const shape of fixture.shapes) expectFindingsCover(fixture, shape);
  }
  fc.assert(
    fc.property(seededCase, ({ seed, kind, shapeName }) => {
      const { fixture, shape } = caseFrom(seed, kind, shapeName);
      expectFindingsCover(fixture, shape);
    }),
    { numRuns: 180, seed: 20261021 },
  );
});
