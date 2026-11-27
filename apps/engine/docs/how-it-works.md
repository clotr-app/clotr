# How the engine works

This page follows one message through Clotr's engine, for anyone who wants to fix or add a rule and hasn't opened the
code yet. `tests/engine-how-it-works.test.js` checks the files and functions it names, the order of the steps in
`detectWindow()` in `extension/engine/detect/detect.js`, the window, overlap and clock numbers, the sections and the example rule.

## What goes in and what comes out

A string goes in. Out comes an array with one result for each kind of detail found, each with the rule's `id`, `group`,
`name` and `severity` and its `matches`, the values as they're written in the text. A password result can also carry
`asks`, and the array gets `truncated: true` when the time limit stopped the scan early. Results come highest severity
first. The exact shapes, and what happens with input that isn't text, are in [interface.md](interface.md). The engine
only finds things. Turning a finding into a warning, a quiet count or a hold is a separate step, `respFor()` in
`extension/engine/respond/decide.js`, which reads the person's own setting for that rule's id.

## The path a message takes

The engine is the classic scripts under `extension/engine/`, in the order `files.js` there lists. They share names through `globalThis.Clotr` and `globalThis.ClotrInternal`, and `tools/engine-bundle.js` joins them.

1. `detect()` in `apps/engine/index.cjs` reads a `String` object as text with `asText()` in `apps/engine/index.cjs`,
   then calls `detect()` in `extension/engine/detect/detect.js` and copies each result into a plain object.
2. `detect()` in `extension/engine/detect/detect.js` adds a team policy's kinds after the table. Saved words only feed the vault
   rules. For the same text, rules and names as the last call, it hands back a copy of the last answer and runs nothing.
3. `detectFresh()` in `extension/engine/detect/detect.js` sets the scan's two limits, a 10-second clock and a character budget.
4. `detectAll()` in `extension/engine/detect/detect.js` reads up to 40,960 characters as one window, and longer text in windows
   of 40,960 characters that overlap by 8,192 characters. `seamParts()` in `extension/engine/detect/detect.js` and `seamRescue()`
   in `extension/engine/detect/detect.js` look after values that cross a seam, and the windows' results are merged into one list.
5. `detectWindow()` in `extension/engine/detect/detect.js` does the work for each window, in this order.
   1. `cleanText()` in `extension/engine/detect/cleaned-text.js` makes a cleaned copy, with invisible characters dropped and odd
      spaces, dashes, quotes and other scripts' digits made plain, and a map from each character back to the original.
   2. Every rule reads the cleaned copy. A rule with `find` gets the text passed to its function, and a rule with
      `regex` gets the text matched against it. The budget is checked before each rule, never in the middle of one.
   3. `secondReading()` in `extension/engine/detect/second-readings.js` makes a second copy with a phone keyboard's dots turned back into
      spaces by `withoutPhoneDots()` in `extension/engine/detect/second-readings.js`, and JSON or log escapes like `\n` blanked out. Built-in
      rules read it too, except `my_name`, `family_name`, `employer`, `my_id` and `watch_list`, which skip it.
   4. When the cleaned copy held a JSON string's `\n` (`jsonBreaks`), or `hasTokenLineBreak()` in
      `extension/engine/detect/second-readings.js` sees a token wrapped over lines, `withoutTokenLineBreaks()` in `extension/engine/detect/second-readings.js`
      joins it back up and every rule reads the joined copy.
   5. `piecedKeys()` in `extension/engine/detect/pieced-keys.js` looks for a key typed in pieces.
   6. For each rule, `addedByReading()` in `extension/engine/detect/pieced-keys.js` keeps only what the second copy found that the
      first didn't. A value from any reading is kept only if the rule's `validate` passes it and, for a rule marked
      `secret`, `isPlaceholder()` in `extension/engine/rules/value-checks.js` doesn't call it a placeholder.
   7. A weaker match is dropped when every place it occurs sits inside a more severe match. A separate copy of it
      keeps its own result.
   8. Each value is mapped back to the text as it was written, so Cover it replaces exactly what the person typed.

## What one rule is made of

Each rule is one entry in the `PATTERNS` table in `extension/engine/rules/rule-table.js`. This is the whole entry for a
DigitalOcean token.

```js
{
  id: "digitalocean_token",
  group: "credentials",
  secret: true,
  name: "DigitalOcean Token",
  severity: "high",
  regex: /\bd(?:op|oo|or)_v1_[0-9a-fA-F]{64}\b/g,
  validate: (token) => looksRandomHex(token.slice(7)),
},
```

- `id` is the name everything else uses. The person's response setting is keyed by it, and results carry it.
- `group` is one of `credentials`, `personal`, `custom` or `links`, and picks the switch in Settings that holds it.
- `secret: true` keeps a docs placeholder quiet, like a run of six of one character or eight characters counting up.
- `name` is the English name a warning shows, swapped at load for a translation keyed by the id.
- `severity` is `high`, `medium` or `low`. It orders the results, and a weaker match inside a stronger one is dropped.
  The default response is Warn at any severity, but `license_plate` and `gamer_tag` start quiet with `start: "log"`.
- `regex` finds the shape, here `dop_v1_`, `doo_v1_` or `dor_v1_` and then 64 hex characters. A rule that needs more
  than one pattern has `find` instead, a function that takes the text and returns the values.
- `validate` runs on each value the regex found. This one skips the 7-character prefix and asks
  `looksRandomHex()` in `extension/engine/rules/value-checks.js` whether the rest has digits, letters, a long unbroken run and
  the spread random hex has.

## The sections of the rules files

Each rules file groups its rules by topic under section headings. [`rules-sections.md`](rules-sections.md) lists
every heading, in the order the files load.

## Where a rule's tests are

Tests aren't kept one file per rule. Most rules have tests in `tests/patterns.test.js`, the biggest file, and
`tests/fixtures/secrets.js` makes up a value for each secret credential kind for the property tests. To find a rule's
tests, search the test files for its id, then run only those files.

```sh
grep -rl --include="*.test.js" digitalocean_token tests
node --test tests/patterns.test.js tests/engine-leaks.test.js tests/engine-recall.test.js
```

Add `--test-name-pattern="<words from a test's name>"` to run single tests. Each rule also has one row in
`docs/engine/rule-reference.md`, with an example and its known limits.

## Changing a rule safely

1. Write the test first, with made-up values, and run it to see it fail. A miss goes in `tests/patterns.test.js`, and a
   false alarm can go in `tests/false-alarms.test.js`.
2. Change the rule, keeping any new regex's repeats bounded.
3. Run the normal-message files, `node --test tests/false-alarms.test.js tests/engine-quiet.test.js`, so everyday
   text and developer text stay quiet.
4. Run the speed check, `node --test --test-name-pattern=ReDoS tests/patterns.test.js`, which feeds every rule in
   the table repeated hostile text and fails one whose time grows too fast. `tests/fuzz.test.js` adds more shapes.
5. Run `node --test tests/fuzz-properties.test.js`, which checks that Cover it leaves no 12-character run of any
   planted secret.
6. Rebuild the bundle the package loads with `node tools/engine-bundle.js`, then run `npm test`.

## Why one table with checks after a match

Every rule goes through the same steps in `detectWindow()` in `extension/engine/detect/detect.js`. So a new way of reading text,
like a wrapped token, helps every rule at once, and no rule has to know about it. The vault rules skip the phone-dot
one. The time limit is checked between rules, so a scan that runs out stops cleanly and says so with `truncated`.

A pattern only finds a shape. A prefix can also start an ordinary word, and a docs example has the right shape too, so
`validate` and the placeholder check decide afterwards whether the value looks real. That keeps each regex short and
bounded.

One table is also one list of ids. The package's `PATTERNS` and the speed check read it, so a new rule is in both the
moment it's in the table, and the rule reference's test fails until the rule has its row.
