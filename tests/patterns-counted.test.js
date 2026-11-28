// Reruns growth tests of tests/patterns.test.js in a child with CLOTR_WORK=1, where they count the work instead of
// timing it. They keep their clock in patterns.test.js, which sees a regex backtracking inside one run, and the count
// sees a pass over the text per find that a busy machine's clock could hide. The child stays out of patterns.test.js
// itself, which the mutator runs once per mutant.
"use strict";

const test = require("node:test");
const path = require("node:path");
const { assertCounted } = require("./work-child.js");

test("the hostile-text growth tests in patterns.test.js also pass on a count of work", () => {
  assertCounted(path.join(__dirname, "patterns.test.js"), [
    "private keys written as JWKs grow linearly on hostile JSON",
    "card security codes grow linearly on hostile text",
    "gift card codes grow linearly on hostile text",
    "gamer tags: the handle reader grows linearly on hostile text",
    "formats a team supplies stay bounded: matched literally, never as a regex; too long refused; linear",
    "a label before a huge run of spaces with no value grows linearly",
    "untrusted label gaps grow in step with their length",
    "PDF streams: found in a real-shaped file, and hostile files grow linearly",
    "Office XML to text: paragraphs and entities read; hostile XML grows linearly",
    "Spanish ID labels, Colombian streets, NDC codes and doctors' titles grow linearly on hostile text",
    "sign-in codes and Spanish bank accounts grow linearly on hostile text",
    "Clean link: a link with a huge query string still scans and cleans in linear time",
    "the key, password, birth date, SSN, policy and routing labels above grow linearly on hostile text",
    "passwords with punctuation, wrapped and escaped keys, and the other password phrasings grow linearly on hostile text",
    "other languages' passwords, CSV columns, commands and named settings grow linearly on hostile text",
    "Azure primary key credential-shape checks grow linearly on repeated labels",
  ]);
});
