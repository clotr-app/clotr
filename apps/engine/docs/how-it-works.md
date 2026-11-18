# How the engine works

This page follows one message through Clotr's engine, for anyone who wants to fix or add a rule and hasn't opened the
code yet. `tests/engine-how-it-works.test.js` checks the files and functions it names, the order of the steps in
`detectWindow()` in `extension/detector.js`, the window, overlap and clock numbers, the sections and the example rule.

## What goes in and what comes out

A string goes in. Out comes an array with one result for each kind of detail found, each with the rule's `id`, `group`,
`name` and `severity` and its `matches`, the values as they're written in the text. A password result can also carry
`asks`, and the array gets `truncated: true` when the time limit stopped the scan early. Results come highest severity
first. The exact shapes, and what happens with input that isn't text, are in [interface.md](interface.md). The engine
only finds things. Turning a finding into a warning, a quiet count or a hold is a separate step, `respFor()` in
`extension/decide.js`, which reads the person's own setting for that rule's id.

## The path a message takes

The engine is `extension/patterns.js`, `extension/detector.js` and `extension/decide.js`, classic scripts loaded in
that order that share what they define through `globalThis.Clotr`, joined into one file by `tools/engine-bundle.js`.

1. `detect()` in `apps/engine/index.cjs` reads a `String` object as text with `asText()` in `apps/engine/index.cjs`,
   then calls `detect()` in `extension/detector.js` and copies each result into a plain object.
2. `detect()` in `extension/detector.js` adds a team policy's kinds after the table. Saved words only feed the vault
   rules. For the same text, rules and names as the last call, it hands back a copy of the last answer and runs nothing.
3. `detectFresh()` in `extension/detector.js` sets the scan's two limits, a 10-second clock and a character budget.
4. `detectAll()` in `extension/detector.js` reads up to 40,960 characters as one window, and longer text in windows
   of 40,960 characters that overlap by 8,192 characters. `seamParts()` in `extension/detector.js` and `seamRescue()`
   in `extension/detector.js` look after values that cross a seam, and the windows' results are merged into one list.
5. `detectWindow()` in `extension/detector.js` does the work for each window, in this order.
   1. `cleanText()` in `extension/detector.js` makes a cleaned copy, with invisible characters dropped and odd
      spaces, dashes, quotes and other scripts' digits made plain, and a map from each character back to the original.
   2. Every rule reads the cleaned copy. A rule with `find` gets the text passed to its function, and a rule with
      `regex` gets the text matched against it. The budget is checked before each rule, never in the middle of one.
   3. `secondReading()` in `extension/detector.js` makes a second copy with a phone keyboard's dots turned back into
      spaces by `withoutPhoneDots()` in `extension/detector.js`, and JSON or log escapes like `\n` blanked out. Built-in
      rules read it too, except `my_name`, `family_name`, `employer`, `my_id` and `watch_list`, which skip it.
   4. When the cleaned copy held a JSON string's `\n` (`jsonBreaks`), or `hasTokenLineBreak()` in
      `extension/detector.js` sees a token wrapped over lines, `withoutTokenLineBreaks()` in `extension/detector.js`
      joins it back up and every rule reads the joined copy.
   5. `piecedKeys()` in `extension/detector.js` looks for a key typed in pieces.
   6. For each rule, `addedByReading()` in `extension/detector.js` keeps only what the second copy found that the
      first didn't. A value from any reading is kept only if the rule's `validate` passes it and, for a rule marked
      `secret`, `isPlaceholder()` in `extension/patterns.js` doesn't call it a placeholder.
   7. A weaker match is dropped when every place it occurs sits inside a more severe match. A separate copy of it
      keeps its own result.
   8. Each value is mapped back to the text as it was written, so Cover it replaces exactly what the person typed.

## What one rule is made of

Each rule is one entry in the `PATTERNS` table near the end of `extension/patterns.js`. This is the whole entry for a
DigitalOcean token.

```js
{
  id: "digitalocean_token",
  group: "credentials",
  secret: true,
  name: "DigitalOcean Token",
  severity: "high",
  regex: /\bd(?:op|oo|or)_v1_[0-9a-fA-F]{64}\b/g,
  validate: (m) => looksRandomAnyCase(m.slice(7)),
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
  `looksRandomAnyCase()` in `extension/patterns.js` whether the rest has digits, letters, a long unbroken run and
  the spread random hex has.

## The sections of extension/patterns.js

The file is one wrapped classic script. Helpers come first, then these sections, in this order, and the `PATTERNS`
table closes it.

1. `Fewer false alarms for credentials` holds `isPlaceholder()` in `extension/patterns.js` and the checks for whether
   a key looks machine-made.
2. `Numbers written any way` is a note that digits, number words or a mix of them all count as a number.
3. `Translations` starts with `msg()` in `extension/patterns.js`, then holds the number reader that note describes,
   `numberRuns()` in `extension/patterns.js`, and the phone, card and Social Security number readers.
4. `Emails, including spelled-out forms` reads email addresses, including ones written out in words.
5. `Where a sentence ends` keeps a detail from running across the end of a sentence.
6. `Street addresses (US style), digits or spelled out` reads US street addresses and PO boxes.
7. `Dates of birth (only next to a birth word, since a plain date isn't personal)` reads birth dates.
8. `Bank and ID numbers: the value right after a label` reads account, routing and license numbers after their label.
9. `Cars and school` reads VINs, license plates and student IDs.
10. `Gamer tags: the handle reader` reads a handle after a clear gaming-account label.
11. `International IDs, medical record numbers, your IP` holds IBANs with their mod-97 check and the UK, Canadian,
    Spanish, Mexican and US ITIN number shapes.
12. `National IDs from other countries` holds other countries' ID numbers, each with its public check.
13. `More EU and EEA personal and tax numbers` holds more European numbers, each with its check digit or birth date.
14. `IDs after a Spanish label, and Colombia's numbered streets` reads IDs after a Spanish label.
15. `Crypto wallets` holds the BIP-39 word list and checks a seed phrase's last-word checksum.
16. `Private keys written as JSON Web Keys` reads private keys in JWK form as the same kind as a PEM block.
17. `Two-step sign-in keys (otp_secret)` reads the secret an authenticator app makes sign-in codes from.
18. `Clean link: a URL's own tracking code` finds the share codes a copied link carries and cleans the link.
19. `Developer secrets: connection strings, JWTs, internal addresses` reads connection strings, JWTs, private
    network addresses, internal hostnames and AWS access keys.
20. `Your vault: things you told Clotr to protect` matches saved words by salted fingerprint and formats by shape.
21. `Passwords and secrets, found by the words around them` reads a secret from the label in front of it.
22. `A downloaded two-step backup-code file` reads a file of backup codes by its title line, and holds the card
    security code reader.
23. `Gift card codes` reads a code after a gift card word. Below it, up to the table, sit `findSecrets()` in
    `extension/patterns.js` and the service-token readers.

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

Every rule goes through the same steps in `detectWindow()` in `extension/detector.js`. So a new way of reading text,
like a wrapped token, helps every rule at once, and no rule has to know about it. The vault rules skip the phone-dot
one. The time limit is checked between rules, so a scan that runs out stops cleanly and says so with `truncated`.

A pattern only finds a shape. A prefix can also start an ordinary word, and a docs example has the right shape too, so
`validate` and the placeholder check decide afterwards whether the value looks real. That keeps each regex short and
bounded.

One table is also one list of ids. The package's `PATTERNS` and the speed check read it, so a new rule is in both the
moment it's in the table, and the rule reference's test fails until the rule has its row.
