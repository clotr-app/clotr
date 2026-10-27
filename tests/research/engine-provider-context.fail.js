// Research regression case: valid provider-shaped values disappear when wrapped inside an indented YAML block.
// Run with `node --test tests/research/engine-provider-context.fail.js`; intentionally failing until the fix cycle.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cases, find } = require("../../tools/engine-provider-context.js");

const samples = cases();

test("RESEARCH CHECK: long synthetic provider values are found before YAML indentation", () => {
  for (const sample of samples) {
    assert.ok(find(sample.raw).includes(sample.expected), `${sample.id}: raw provider value was missed`);
    assert.ok(find(sample.wrapped).includes(sample.expected), `${sample.id}: terminal-wrapped value was missed`);
    assert.ok(find(sample.json).includes(sample.expected), `${sample.id}: JSON-escaped line wrap was missed`);
  }
});

test("RESEARCH FAILING: wrapped provider values keep their own kind in an indented YAML block", () => {
  const misses = samples.flatMap((sample) => {
    const lf = find(sample.yamlLf);
    const crlf = find(sample.yamlCrlf);
    return [
      ...(!lf.includes(sample.expected) ? [`${sample.id}/LF: ${lf.join(", ") || "no finding"}`] : []),
      ...(!crlf.includes(sample.expected) ? [`${sample.id}/CRLF: ${crlf.join(", ") || "no finding"}`] : []),
    ];
  });
  assert.deepEqual(misses, []);
});
