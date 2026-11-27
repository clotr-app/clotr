# Engine interface

Engine version: 1.6.1

This page lists every name Clotr's engine gives other code, in four parts. The package and ClotrHost are for anyone
building on the engine. The third part is the names Clotr's own apps read from `globalThis.Clotr`, and the fourth is
everything else there, which is internal. `tests/engine-interface.test.js` fails when a name, or a field in what one
returns, is added, dropped or renamed without `tests/fixtures/engine-interface.json` changing with it.

Each row below was checked by running it from a copy of the package in a temp folder. The last column says what
happens when the main argument is `null`, `undefined`, a number, an object or an array instead of text.

## The package

`require("clotr-engine")` and `import { detect, redact, PATTERNS } from "clotr-engine"` give the same three names.
The package runs the engine in a sandbox of its own, so loading it leaves `globalThis` alone. Its types are in
`index.d.ts`.

| Name | What it's for | Takes | Returns | Input that isn't text |
| --- | --- | --- | --- | --- |
| `detect(text)` | Finding the details in a text | A string | An array with one result for each kind found, highest severity first | `null`, `undefined` and arrays throw a `TypeError`, while a number or a plain object gives `[]` |
| `redact(text, results)` | Hiding what `detect()` found | The text, and the results from `detect()` on that text or a copy with some taken out | The text with each value swapped for a label like `[REDACTED PHONE NUMBER]`, or a share link cleaned | A text that isn't a string, or results that aren't an array, give `""`, though leaving `results` out gives the text back unchanged |
| `PATTERNS` | Listing the kinds, to filter on them | Nothing | A frozen array of the 66 built-in rules, each a frozen `{ id, group, name, severity }` | Doesn't apply |

A result has the rule's `id`, `group`, `name` and `severity`, and `matches`, which holds the values found as they're
written in the text. It doesn't say where they are. A password result can also carry `asks`, the kinds of code
someone asked for, which are `login_code`, `remote_code`, `recovery_codes`, `security_answer` and `home_code`. The
array itself gets `truncated: true` when the time limit stopped the scan before the end, so read it before filtering.

`group` is `credentials`, `personal`, `custom` or `links`, and `severity` is `high`, `medium` or `low`. `redact()`
hides only values the engine finds in that same text. A result written by hand hides nothing `detect()` wouldn't
find there.

## ClotrHost

The engine bundle sets `globalThis.ClotrHost` when it loads. Clotr for Android, Clotr for Windows and the VS Code and
JetBrains plugins all go through it, but the package doesn't export it yet. To use it, build the bundle with
`node tools/engine-bundle.js` and run `apps/engine/dist/clotr-engine.js` in any JavaScript engine. It needs no
browser.

ClotrHost writes nothing anywhere. It keeps the settings `init()` was given, and in memory it keeps the findings of
the last four texts it checked and up to 64 found details, so `redact()` and `eventsFor()` can refer back to a
`check()`.

| Name | What it's for | Takes | Returns | Input that isn't text |
| --- | --- | --- | --- | --- |
| `init(settings)` | Setting the engine up for the app's settings and the person's language | The app's stored settings with its 32-character `salt`, and `locale`, like `"es"` or `"es-MX"` | `{ locale, salt, vault }`, which is the language picked, whether a salt was kept and how many saved details were kept | Anything that isn't an object counts as no settings and gives `{ locale: "en", salt: false, vault: 0 }` |
| `check(text, options)` | Finding the details and what each one does in this app | The text and `{ app, everyday, source }`, where `app` is the app's id, `everyday` is `true` for an email or chat app the person switched on, and `source` is `"typed"` or `"copied"` | `{ findings, words, holds }`, plus `truncated: true` when the time limit stopped the scan early | A text that isn't a string, an empty text or a paused app gives `{ findings: [], words: null, holds: false }`, and options of `null` throw a `TypeError` |
| `redact(text, findingIds)` | Hiding the details the person picked | The text given to `check()` and the `id` of each finding to hide | The text with each picked detail swapped for its label, or a share link cleaned | A text that isn't a string gives `""`, ids that aren't an array hide nothing, and an id that isn't there changes nothing |
| `fingerprintFor(type, value)` | A saved detail's fingerprint, for the screen that lists them | A kind's `id` and the value | 16 hex characters, the same as a finding's `fp` | `""` when there's no salt yet, `type` isn't 2 to 40 lowercase letters and underscores, or the value isn't a string with something in it. A `type` of that shape gets a fingerprint even when no kind has that id |
| `eventsFor(findings, action, app, text)` | History rows for findings the person answered | Findings from `check()`, the action, the app's id, and the checked text in case the engine started again since the check | One row per finding | Findings that aren't an array give `[]`, and so does an action other than `"redacted"`, `"allowed"`, `"suppressed"` or `"mentioned"` |
| `clean(settings)` | Keeping only what may be stored | The app's settings | The same settings with unknown keys and bad values dropped | Anything that isn't an object gives `{}` |
| `call(request)` | One way in for an app that can only pass text | `{ method, args }` as a JSON string or an object, naming one of the six methods above | A JSON string, either `{"result": ...}` or `{"error": "<kind>"}` | Anything but a request for one of the six gives `{"error":"unknown-method"}`. Broken JSON gives `{"error":"SyntaxError"}`, `call("null")` gives `{"error":"TypeError"}`, and a method that throws gives the error's name with no message |

Each finding in `check()`'s answer has these fields.

- `id`, like `"1.0"`, is the same for the same text and settings.
- `type` is the kind's id. `name`, `severity` and `group` are the rule's.
- `response` is `"log"`, `"warn"` or `"block"` for this app.
- `preview` is the value masked, like `555-…36`.
- `fp` is a fast fingerprint for matching, 16 hex characters, or `""` with no salt. `scheme` is always `2`.

`words` is the warning's sentence as `{ lead, items, tail }`. It names each finding that isn't only logged, and it's
`null` when there's none. `holds` is `true` when any finding's response is `"block"`.

A History row from `eventsFor()` is `{ t, site, type, name, severity, action, fp, scheme }`. `site` is `app:`
followed by the app's id, and `fp` is History's slower, stronger fingerprint, made for at most eight findings per
call. It's `""` when there's no salt or the detail isn't one a recent `check()` found.

`clean()` keeps the extension's own backup settings, plus `pausedApps` and `appModes` for the app's own pause and
modes.

## Names Clotr's apps read from `globalThis.Clotr`

These are on `globalThis.Clotr` once the bundle loads, and Clotr's apps read them directly. The package doesn't
export them. `tests/engine-interface.test.js` fails when an app starts reading a name that isn't in this table, or
stops reading one that is. That check needs a private tool that counts the reads, so the public repo skips it.

| Name | Read by | What it's for | Takes | Returns | Input that isn't text |
| --- | --- | --- | --- | --- | --- |
| `PATTERNS` | Guard, JetBrains, Windows | The rules as the engine runs them | Nothing | The 66 built-in rules, each with `id`, `group`, `name` and `severity` and some of the engine's own fields, `find`, `secret`, `regex`, `validate`, `labelAnywhere`, `bandage`, `picture`, `start` and `replace`. It isn't frozen, and `init()` renames the rules in the person's language | Doesn't apply |
| `msg(key, english, ...values)` | Windows | Words in the person's language | A message key, the English text, and values for `$1`, `$2` and so on | The translated text, or the English with the values filled in | With no English and no translation it gives `undefined` |
| `detect(text)` | Guard, VS Code, JetBrains, Android, Windows | Finding the details in a text | A string | Results with each rule's own fields plus `matches`, and `asks` and `reasonOf` on a password result that has them. The array can have `truncated` | The same as the package's `detect()` |
| `DETECT_WINDOW_CHARS` | JetBrains | The length of the windows `detect()` reads a long text in, so the plugin can tell where a cut-short check stopped | Nothing | 40,960 characters | Doesn't apply |
| `DETECT_WINDOW_OVERLAP` | JetBrains | How far those windows overlap | Nothing | 8,192 characters | Doesn't apply |
| `redact(text, results)` | Guard, JetBrains, Windows | Hiding what `detect()` found | The text and results from `detect()` | The text with each value swapped for its label | A text or results of the wrong type throw a `TypeError` |
| `generalForms(results, locale)` | Windows | The general form of a birth date or an address | Results and a locale like `"en-US"` | `[{ id, general }]`, with the month and year of a birth date or the town of an address | Results that aren't an array throw a `TypeError` |
| `fingerprint(salt, type, value)` | Android, Windows | The fast fingerprint | The salt, a kind's id and the value | 16 hex characters | A value that isn't a string throws a `TypeError`, and a missing salt is hashed as the word `null` or `undefined` |
| `mask(value, kind)` | Guard | Showing a value safely | A string, and the finding's kind id if there is one | Eight characters or fewer become dots. A longer password, PIN, backup code, seed, two-step sign-in key, card security code, gift card code, private key or connection string becomes eight dots, and any other value, or one with no kind, keeps at most a quarter of itself around `…`, two characters at each end at most | A value that isn't a string throws a `TypeError` |
| `responseOf(kind, settings)` | Windows | What a kind does by default | A kind's id and `{ responses, siteMode }` | `"log"`, `"warn"` or `"block"`, with `siteMode` winning when it's set | Settings left out throw a `TypeError`, and an unknown kind gives `"warn"` |
| `splitOwnIds(results, settings)` | Guard | Telling the person's own ID apart from others of the same shape | Results and `{ salt, vault }` | The results, with any ID that isn't the person's split off as Account/ID Number at medium severity | Settings left out throw a `TypeError`. With no saved ID the results come back as they were, even `null` |
| `noticeWords(results, options)` | Windows | The warning's sentence | The results to name and `{ everyday, source }` | `{ lead, items, tail }`, the same shape as ClotrHost's `words` | Results that aren't an array throw a `TypeError`, and `[]` still gives a sentence with no items |
| `Backup` | Windows | The encrypted settings file for moving to a new computer | Nothing | An object with `FORMAT`, `KEYS`, `ITERATIONS`, `MAX_FILE_BYTES`, `pick(storage)`, `seal(settings, password)`, `open(text, password)` and `clean(settings)`. `seal()` and `open()` return promises | `open()` rejects anything that isn't a string with `not-a-backup`, `pick(null)` throws, and `seal()` needs Web Crypto, so it rejects in an engine without it |
| `commandTrick(copied, around)` | Windows | Spotting a copied command someone was tricked into running | The copied text and the text around it | `{ shape: "hidden" }`, `{ shape: "download" }` or `null` | Anything that isn't a string gives `null` |
| `askSomeoneNoteForScamSigns(signIds, lang)` | Windows | The note asking someone to look at a scam message | Sign ids, and `"es"` for Spanish | The note, or `""` when no sign id is known | Ids that aren't an array give `""` |
| `askSomeoneNoteForCommand(lang)` | Windows | The note asking someone to look before a copied command runs | `"es"` for Spanish | The note | Anything but `"es"` gives English |
| `askSomeoneNoteForShare(lang)` | Windows | The note asking someone to look before something private goes to an AI chat | `"es"` for Spanish | The note | Anything but `"es"` gives English |

Guard runs the bundle in a `vm` context of its own, so it reads these from that context's `Clotr`, the object the
bundle sets as `globalThis.Clotr`. Its `clean_text` tool in `apps/guard/bin/clotr-mcp.js` is where it reads `redact`.
Clotr MCP runs that same server, so it reads what Guard reads.

Clotr for Windows and Clotr for Android also load a bigger bundle, with the readers for files and exports after the
engine's parts. The names those add belong to the readers, so they aren't listed here.

## Internal names

The other 58 names on `globalThis.Clotr` are internal. They're shared between the engine's own files, the extension
and the tests, and none of Clotr's apps reads them. `useLocale` comes from the bundle's own start, and `detect()` sets
`overlapChecks` on its first long scan.

"Set by" names the engine file that defines each name. The last file of its group (`rule-table.js`, `detect.js` or
`decide.js`) is the one that puts it on `globalThis.Clotr`.

The last column names the files in the public repo. Some readers aren't in it, like private tools and tests and the
website's copies of the extension's files, so they're counted as private files instead.

| Name | Set by | Read by |
| --- | --- | --- |
| `useLocale` | `apps/engine/host-shim.js` | `apps/engine/host.js` |
| `ASK_REASONS` | `extension/engine/rules/passwords-and-codes/scam-requests.js` | `extension/engine/detect/detect.js`, `extension/engine/respond/decide.js`, `tests/decide.test.js` and 2 private files |
| `askLabels` | `extension/engine/rules/passwords-and-codes/scam-requests.js` | `extension/scam-signs.js`, `tests/scam-signs.test.js` and 1 private file |
| `numberRuns` | `extension/engine/rules/numbers/number-runs.js` | `extension/engine/respond/fingerprints.js` and 1 private file |
| `isPlaceholder` | `extension/engine/rules/value-checks.js` | `extension/engine/detect/detect.js`, `extension/engine/detect/pieced-keys.js` and 2 private files |
| `setVault` | `extension/engine/vault/saved-words.js` | `apps/engine/host.js`, `extension/check.js`, `extension/content.js`, `extension/lookback-core.js`, `tests/bandage.test.js`, `tests/engine-hosts.test.js`, `tests/engine-r2-vault-quiet.test.js`, `tests/engine-r2-vault.test.js`, `tests/patterns.test.js`, `tests/vault-page.test.js` and 1 private file |
| `vaultKinds` | `extension/engine/vault/saved-words.js` | `extension/content.js`, `extension/engine/detect/detect.js`, `extension/engine/respond/bandage-labels.js`, `tests/patterns.test.js` and 1 private file |
| `isVaultFormat` | `extension/engine/vault/saved-words.js` | `extension/engine/respond/cover-values.js` and 1 private file |
| `isClosedLetter` | `extension/engine/vault/saved-phrases.js` | `extension/engine/respond/fingerprints.js` and 1 private file |
| `closedLength` | `extension/engine/vault/saved-phrases.js` | `extension/engine/respond/fingerprints.js` and 1 private file |
| `closedHead` | `extension/engine/vault/saved-phrases.js` | `extension/engine/respond/fingerprints.js` and 1 private file |
| `vaultCutShort` | `extension/engine/vault/saved-words.js` | `extension/engine/detect/detect.js` and 1 private file |
| `setScanDeadline` | `extension/engine/vault/saved-words.js` | `extension/engine/detect/detect.js` and 1 private file |
| `setVaultSource` | `extension/engine/vault/saved-words.js` | `extension/engine/detect/detect.js` and 1 private file |
| `utf8At` | `extension/engine/vault/vault-unescape.js` | `extension/engine/respond/cover-values.js` and 1 private file |
| `addressCore` | `extension/engine/rules/personal/street-addresses.js` | `extension/engine/respond/fingerprints.js`, `extension/vault.js`, `tests/patterns.test.js` and 1 private file |
| `cleanableParamsOf` | `extension/engine/rules/personal/link-tracking-codes.js` | `extension/warning-ui.js` |
| `cleanShareLink` | `extension/engine/rules/personal/link-tracking-codes.js` | `tests/patterns.test.js` |
| `findShareLinks` | `extension/engine/rules/personal/link-tracking-codes.js` | `tests/patterns.test.js` |
| `sha256Bytes` | `extension/engine/rules/key-formats/crypto-wallets.js` | `tests/engine-held-speed.test.js`, `tests/patterns.test.js` |
| `SEVERITY_RANK` | `extension/engine/detect/cleaned-text.js` | No other file |
| `DETECT_BUDGET_CHARS` | `extension/engine/detect/cleaned-text.js` | No other file |
| `DETECT_BACKSTOP_MS` | `extension/engine/detect/cleaned-text.js` | `apps/engine/test/engine-package.test.cjs`, `tests/engine-hosts.test.js`, `tests/engine-interface.test.js`, `tests/guard-scale-cutoff.test.js`, `tests/mcp.test.js`, `tests/patterns.test.js` and 1 private file |
| `DETECT_PRIVATE_KEY_FALLBACK_CHARS` | `extension/engine/detect/cleaned-text.js` | `tests/patterns.test.js` |
| `generalize` | `extension/engine/respond/generalize.js` | `extension/content.js`, `tests/engine-r2-vault.test.js`, `tests/fuzz-properties.test.js`, `tests/patterns.test.js`, `tests/redact.test.js` |
| `wordStarts` | `extension/engine/respond/cover-values.js` | `extension/content.js`, `extension/editor.js` |
| `isSavedWord` | `extension/engine/respond/cover-values.js` | `extension/content.js` |
| `BANDAGE_WORDS` | `extension/engine/respond/bandage-labels.js` | `tests/bandage.test.js` and 1 private file |
| `BANDAGE_BORN_IN` | `extension/engine/respond/bandage-labels.js` | `tests/bandage.test.js` |
| `readBandageLabels` | `extension/engine/respond/bandage-labels.js` | `extension/content.js`, `tests/bandage.test.js`, `tests/e2e/checks/15-performance.js` |
| `bandageKindOf` | `extension/engine/respond/bandage-labels.js` | `extension/content.js`, `tests/bandage.test.js` |
| `RESPONSES` | `extension/engine/respond/responses.js` | `extension/popup.js` |
| `defaultResponse` | `extension/engine/respond/responses.js` | `extension/background.js`, `extension/popup.js`, `tests/patterns.test.js` |
| `responseFor` | `extension/engine/respond/responses.js` | `extension/background.js`, `extension/content.js`, `extension/engine/respond/decide.js`, `extension/popup.js`, `extension/sites.js`, `tests/patterns.test.js` and 1 private file |
| `stricter` | `extension/engine/respond/responses.js` | `extension/background.js`, `extension/content.js`, `extension/sites.js`, `extension/warning-ui.js`, `tests/patterns.test.js`, `tests/sites.test.js` |
| `normalize` | `extension/engine/respond/fingerprints.js` | `tests/engine-held-speed.test.js`, `tests/fingerprint-strength.test.js`, `tests/patterns.test.js` |
| `cleanText` | `extension/engine/detect/cleaned-text.js` | `tests/engine-r2-vault.test.js` |
| `findPdfStreams` | `extension/engine/detect/attachment-text.js` | `extension/attachments.js`, `tests/patterns.test.js` |
| `pdfPageText` | `extension/engine/detect/attachment-text.js` | `extension/attachments.js`, `tests/attachments.test.js`, `tests/patterns.test.js` |
| `xmlToText` | `extension/engine/detect/attachment-text.js` | `extension/attachments.js`, `tests/attachments.test.js`, `tests/patterns.test.js` |
| `sha256` | `extension/engine/respond/fingerprints.js` | `extension/sites.js`, `tests/engine-r2-vault.test.js`, `tests/fingerprint-strength.test.js`, `tests/patterns.test.js`, `tests/sites.test.js` |
| `fingerprintStrong` | `extension/engine/respond/fingerprints.js` | `apps/engine/host.js`, `extension/content.js`, `extension/vault.js`, `tests/decide.test.js`, `tests/e2e/checks/08-vault.js`, `tests/e2e/checks/15-performance.js`, `tests/e2e/checks/18-bandage.js`, `tests/fingerprint-strength.test.js`, `tests/vault-speed.test.js` and 1 private file |
| `fingerprintFor` | `extension/engine/respond/fingerprints.js` | `extension/check.js`, `extension/engine/respond/decide.js`, `tests/fingerprint-strength.test.js`, `tests/vault-speed.test.js` and 1 private file |
| `wordEntry` | `extension/engine/respond/fingerprints.js` | `extension/background.js`, `extension/vault.js`, `tests/engine-r2-vault-quiet.test.js`, `tests/engine-r2-vault.test.js` |
| `overlapChecks` | `extension/engine/detect/detect.js` | `tests/patterns.test.js` and 1 private file |
| `describeValues` | `extension/engine/respond/decide.js` | `extension/warning-ui.js`, `tests/decide.test.js` |
| `vaultMode` | `extension/engine/respond/decide.js` | `extension/content.js`, `tests/decide.test.js`, `tests/e2e/checks/15-performance.js`, `tests/vault-speed.test.js` |
| `respFor` | `extension/engine/respond/decide.js` | `apps/engine/host.js`, `extension/content.js`, `tests/decide.test.js`, `tests/vault-speed.test.js` |
| `WHO_ASKS` | `extension/engine/respond/decide.js` | `tests/decide.test.js` |
| `whoAsksFor` | `extension/engine/respond/decide.js` | `tests/decide.test.js` |
| `whoAsks` | `extension/engine/respond/decide.js` | `extension/page-notice.js`, `extension/warning-ui.js`, `tests/decide.test.js`, `tests/e2e/checks/22-who-asks.js` and 1 private file |
| `asShown` | `extension/engine/respond/decide.js` | `extension/page-notice.js`, `extension/warning-ui.js`, `tests/decide.test.js` and 1 private file |
| `VAULT_MODES` | `extension/engine/respond/decide.js` | `extension/background.js`, `tests/decide.test.js` |
| `vaultKey` | `extension/engine/respond/decide.js` | `extension/background.js`, `tests/decide.test.js` |
| `dedupeVault` | `extension/engine/respond/decide.js` | `apps/engine/host.js`, `extension/background.js`, `tests/decide.test.js`, `tests/fingerprint-strength.test.js` |
| `cleanVaultEntry` | `extension/engine/respond/decide.js` | `apps/engine/host.js`, `extension/background.js`, `extension/vault.js`, `tests/decide.test.js`, `tests/engine-r2-vault.test.js`, `tests/fingerprint-strength.test.js`, `tests/vault-page.test.js` |
| `cleanEvent` | `extension/engine/respond/decide.js` | `apps/engine/host.js`, `extension/background.js`, `tests/decide.test.js`, `tests/fingerprint-strength.test.js` |
| `commandShapes` | `extension/commands.js` | `tests/commands.test.js` |
