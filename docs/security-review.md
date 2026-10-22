# Clotr security review

This review covers everything in `extension/` plus the update tooling in `tools/`. It works through code review of
every entry point, backed by automated checks that now run on every change, listed at the end.

## Found and fixed
| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| 1 | **ReDoS in the email pattern.** Unbounded repeats backtracked quadratically, and 20k characters like `a-a-a-…` took about 3 s | Any page, or a pasted log, could freeze typing and Enter | Each part bounded by its real limit, 64 characters for the local part, 253 for the domain and 63 for a label | Unit "no pattern is slow on hostile text", a fuzz of every pattern |
| 2 | Same class in the internal-hostname pattern, about 0.3 s per 20k characters | Smaller freeze | Labels bounded to 63, at most 8 | Same fuzz |
| 3 | Same class in the street-address pattern, 4 s per 40k characters of number words | Enter froze | Spelled-out house numbers capped at 8 words in 0.9.7 | Unit budget test, e2e PERF1 |
| 4 | After an update, the orphaned copy's dialog couldn't close and blocked Enter | The chat could get stuck | Extension calls can't throw into the UI, and the orphaned copy only warns, since 0.9.5 and 0.9.9 | e2e FO1–FO4 |

## Reviewed, no change needed
- Clotr sets no `externally_connectable` and no web-accessible resources, so a web page can't message Clotr or
  load its pages. The background only accepts messages from Clotr's own scripts, checked through `sender.id`, and
  it validates every write. Events are rebuilt field by field through `sanitize`, vault entries must be
  fingerprint- or format-shaped through `cleanVaultEntry`, and type ids must match `^[a-z_]{2,40}$`.
- The dialog and notice live in closed shadow roots, so page scripts can't read them or press their buttons.
  Synthetic events don't activate buttons, and the page has no reference to them in the first place. Detected
  values are masked in the UI regardless.
- The fingerprint salt reaches only Clotr's content-script world, which is isolated from page scripts, and
  extension pages. "What Clotr stores" keeps it hidden from view.
- There's no remote code and no network call. Clotr never uses `eval`, `Function` or `innerHTML`, which a test
  enforces, and every `fetch` reads one of the extension's own files through `chrome.runtime.getURL`, like
  `manifest.json` for the local update check, also enforced by a test.
- Permissions cover the built-in AI sites only. Any other site needs the person to click "Protect this site" and
  approve it as one optional host permission, narrowed to the chosen section on a shared host.

## Added later (v0.9.27–0.9.31)
| # | Finding | Fix | Test |
|---|---------|-----|------|
| 5 | Invisible or look-alike characters from copied text, like no-break spaces, zero-width spaces and full-width digits, hid leaks | Text cleaned before checking, with matches mapped back to the original | Unit and e2e UN1, and a rule test that keeps raw invisible and bidi characters out of shipped files |
| 6 | Paste-then-Enter sent before the warning could be read | "Just sent" after a confirmed send | e2e FS1–FS3 |
| 7 | Word, Excel and PowerPoint attachments were never read | Unzipped with hard zip-bomb caps, failing open | e2e R8d, R8x and R8z |
| 8 | An attached file's name was logged | Only the extension is logged | A rule test that keeps values, drafts and file names out of logs |
| 9 | In PDF parsing on attacker-controlled files, a regex stream finder took 24 s on 900 KB of unclosed dictionaries | Linear, bounded scanners using indexOf and capped windows, with inflation capped | Unit growth tests, and e2e R8p, R8q and R8r |
| 10 | In Office documents, the XML tag stripper `/<[^>]*>/g` took 54 s on 600 KB of `<a <a <a…`, under every size cap | One linear pass, with entities looked up at most 10 characters ahead | Unit growth test, `assertLinear` |
| 11 | PDFs without stream lengths caused up to 400 searches to the end of a 20 MB file | Search capped to 2 MB ahead and 50 such streams | e2e R8s |
| 12 | Clotr started after the page's scripts, at document_idle, so a site's own early window-level Enter handler could send before Ask before sending held the message | Start at document_start, on built-in and user-added sites | e2e EG1, reproduced first, a test that enforces it, and real ChatGPT re-checked |
| 13 | Unlabeled send buttons bypassed Ask before sending | Composer buttons count as possible sends, and Warn records only after the box empties | e2e UB1–UB3b |
| 14 | Vault fields could be kept in the browser's restore data or sent to cloud spell check | Autocomplete and spellcheck off, cleared on pagehide | e2e V1s |
| 15 | Release packaging shipped every file in `extension/` except logs. A personal note, saved chat or editor backup left in the folder would have gone into a public zip | Only files git tracks are packaged, with a warning outside a git checkout, and zips are reproducible with a published SHA-256 | A unit test checks that an untracked file with a phone number never reaches the zip |
| 16 | On sign-in pages on AI hosts, a username field, a password shown as text after "show password", a one-time code or a sign-up form was watched like a chat box, so Clotr warned there and could record a fingerprint of your own login details | Inputs that are clearly sign-in fields are left alone, going by autocomplete hints, password or code names and labels, or a password field in the same form | e2e LG1, proven to fail before the fix, and the chat box on the same page still warns |
| 17 | Hide it, then called Cover it, could fail silently. On an editor that applies edits later, like Kimi's, the key stayed in the box along with a hidden copy, the notice closed and history said *Hidden*, so a user would send it believing it was gone | Clotr waits for the editor's own update, records *Covered* only when the text really changed, and otherwise says "Clotr couldn't cover it here… delete it by hand" | e2e KM1 and KM2, both failing before the fix, and verified on kimi.com |
| 18 | Tab state was lost after an in-page navigation. Sites that change their URL without reloading, like a new ChatGPT chat or grok.com right after loading, made the background forget the tab, so the badge vanished and the tab looked unprotected | When a load completes and the tab is unknown, the background asks the tab's Clotr and restores its state from the answer | e2e HC4, which fails before the fix, and verified on grok.com |
| 19 | The part of Clotr running inside AI pages could read all of Clotr's storage, meaning your whole history across AI sites, every site's settings and the salt, and write any of it | Storage is locked to Clotr's own pages and worker. The in-page part asks by message for just what it needs, which is its own site's pause and mode, responses, vault and tips, and can only change responses through a checked message. It still gets the vault fingerprints and the salt, because fingerprints are made inside the page so your typed text never leaves it, and Firefox has no storage lock | e2e SEC1, which fails before the fix, a test enforcing that content scripts never use storage, and Firefox 4/4 |
| 20 | A page that removed Clotr's dialog, whether hostile or an app rebuilding the page, left you stuck with *Ask before sending*. Every Enter was held, the dialog never showed, and focus was left on the page instead of the chat box | Clotr notices its box vanishing without it closing it. It stops holding messages on that page, failing open, gives the keyboard back to the chat box, and the self-check says "This page removed Clotr's warnings" with a red ! badge | An e2e check, stuck before the fix |
| 21 | Found while testing the fix above. Since the storage lock of finding 19, a chat tab still starting up could miss a settings change made in the popup meanwhile, until it was hidden and shown again | Changes are announced to every tab, including those not registered yet | e2e SET1, and EG1 caught it |
| 22 | Can a hostile page plant fake entries in your history by filling and emptying its own chat box with no user action? | Not in the test. A page that filled its box with a detail and emptied it by script, with no Enter or click from you, left nothing recorded as *sent* | An e2e check, kept as a regression test |
| 23 | **A page could probe your vault.** It could put guesses like "Emma? Liam?" in its own chat box by script, fire a fake input event or Enter, and watch whether Clotr's warning appeared. Vault names only warn when they're yours, so that revealed them. The reply check was a second way, since after one real send the page could add guess after guess as "reply" text for 90 seconds | Clotr reacts only to events the browser marks as the person's own, and ignores the trusted events a script can cause, which "Events a page's script can cause" below covers. The reply is checked once per message sent, after it has been quiet for 3 seconds | e2e SEC2-SEC8, RP5 |
| 24 | Clotr's pages could have connected out if a future change tried | A strict CSP, with `connect-src 'self'`, `object-src 'none'` and more | A rule test, and e2e CSP1, proven to fail without it |

ChatGPT, Gemini and Grok were checked on the real sites, logged out and with fake data, and all three send nothing
typed before Send. `tools/draft-leak-monitor.js` verified it, with a positive control.

- The full report, added in 0.9.37-0.9.40, only reads history. Fingerprints are used for counting and never shown,
  checked by e2e DSH2. Every value is set as text rather than markup. The export is a file the person asks for,
  built without the fingerprint secret, so its fingerprints can't be matched against guesses, checked by e2e DSH3.
  Retention is validated in the background, allowing only 90, 365 or 730 days. The share card holds counts only.

## Bandage and the live line (0.9.95-0.9.98)
- While typing, the label-to-detail map exists only in the page's memory, keyed by a salted fingerprint, and
  nothing new gets stored. Events record only that a detail was covered, with its fingerprint, as
  `via: "bandage"`. Keys and passwords are never covered, so they always keep their warning. If a chat box
  refuses the edit, the detail falls back to the normal warning, failing open. The per-site on/off setting can
  only be set by a message from that site's own tab.
- Hovering to peek never changes the AI's page. Labels are found with live Ranges, and Clotr's hotspots and
  bubble live in closed shadow roots, so the page can see that a Clotr element appeared but never what it shows.
  Showing the person their own detail in the bubble is deliberate, since these are personal details rather than
  keys, which stay masked everywhere. A page that plants a fake label gets a hotspot but learns nothing. "Copy
  with real names" writes to the clipboard only on a click, and an e2e check confirms the reply's HTML stays
  exactly as the site wrote it.
- With Bandage on, the reply window also looks for Clotr's own labels for 90 seconds after a send, and nothing
  from a reply is kept.
- From 1.2.0, with Bandage on, Clotr also reads the conversation the page shows, the whole page once per chat and
  then only what changes, at most twice a second. This is only to find its own labels, so a new detail never
  reuses one after a reload. Nothing from it is kept, and a label from before the reload never shows a detail.
  This lives in `readBandageLabels` in `detector.js`, and is checked by an e2e test.
- The 1.2.0 review found that a hotspot didn't remember its chat. After you opened another chat from the site's
  sidebar, a label still on the page from the chat you left could show the new chat's detail under the same
  label. Each hotspot now keeps its own chat and shows only that chat's detail, and all of them disappear the
  moment the chat changes. An e2e check caught this, and failed before the fix.
- The unpacked build, for development only, reloads when `local-update.txt` changes. That file is git-ignored and
  packaging only takes tracked files, so it can't ship. Only someone who can already write to the extension's
  folder can trigger a reload.
- Backups carry the Bandage setting, checked as host to true/false on load.

## The team pack (0.9.101)
- There are no new permissions, since the manifest changes only its version. `storage.managed_schema` gains the
  preset, `orgName` and format fields, each one typed and capped.
- The "policy applied" page, `policy.html` and its script, only reads the managed policy. It writes nothing, which
  is checked against `storage.local` before and after, makes no request beyond the extension's own files, and
  builds every field with `textContent`. The office's watch words appear only after the person ticks the box, and
  the fingerprint is a hash of the policy itself rather than of anything typed.
- The floor, `Clotr.stricter`, ranks block over warn over count, and an unknown response counts as warn. A
  person's own "OK to share" entry, or a site set to "Just count", stays saved but can't lower a required
  response while the policy holds. Warnings still never stop a message on their own, since Clotr fails open.
- Watch formats, like `EMP-#####`, are capped at 20 formats of at most 40 characters each, rising to 50 formats
  and 500 words from 1.3.0, shared with a team's own kinds. They're read by the vault's existing format matcher,
  which the ReDoS fuzz already covers, and a format is never hashed as a literal phrase.
- No blocking issues.

## The release candidate (1.0.0-1.0.9)
This review covers everything in `extension/` that changed since the team pack's review, plus the public export
and the website's split. It works through the diff line by line, a search for every API that sends, stores, runs
code or acts on the page, and a ReDoS and timing sweep on 50,000 characters of hostile input. That input mixes
letters, digits, number words, misspellings, brackets, zero-width characters, and key and email look-alikes.

| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| 25 | **Reading a long run of digits was quadratic.** For every digit added to a run, the list-marker check for "1." or "2)" walked the whole run first, and 40,000 digits took about a second. It's older than 1.0, and 0.9.101 did the same | A huge numeric paste froze the chat page for a second or more | The cheap tests come first, at most 3 digits and a "." or ")" gap, and the worst case of the sweep went from 958 ms to 130 ms in 1.0.9 | Unit test, four times the digits take about four times as long |

- There are no new permissions since 0.9.101. The manifest only changed its name and version.
- Report a problem, in `report.js`, opens GitHub's issue forms with `noopener`. The address carries only the
  form, Clotr's version, the browser, and the AI site's name if the person ticked "Include this site". It never
  carries typed text, a stored value or a fingerprint. The false-alarm link names only the kind of detail, and a
  warning that reports are public comes before any choice.
- Leave it in and send only acts after the person's own click or Enter press on Clotr's dialog, which lives in a
  closed shadow root the page can't reach. It only triggers through whatever they used to send, which is their
  button or form, the site's own send button near the chat box for Enter, or Enter again. The page can't start it.
  Allowed details stay in memory for that one message, and nothing is stored.
- The reply window, added in 1.0.8, stays open up to 90 seconds to place cover-name hotspots in Clotr's own
  layer. It reads only text the page shows, and the vault's reply check still runs once per message, as finding
  23 above describes.
- The edit check, added in 1.0.7, ignores zero-width characters when it compares the chat box with Clotr's text,
  and changes no detection.
- Moving to a new computer reports what a file holds and what came back only as counts, like "3 vault items, a
  PIN", never a detail or the PIN itself.
- The names and addresses were settled in 1.0.6. Firefox knows the add-on as clotr@billiambash, and Report a
  problem opens issues at github.com/clotr-app/clotr, the public repo's home since it moved there. Releases from
  before the move link to github.com/BilliamBaSH/clotr, which forwards to it, so the address in the extension never
  points at someone else's repo.
- No blocking issues.

## The 1.3.0 candidate
This review covers the pieces that ask the browser for sites, run a team's own patterns, or read the files and
pictures people attach. It works through the code paths line by line, the automated checks that guard them, and
hostile-input tests.
- Asking the browser for sites happens in three functions only, each one enforced by a test, so a planted ask
  anywhere else, even through an alias or a bracket lookup, fails the tests. The first asks for email and chat apps
  by name from the built-in list, so nothing else can be asked for. The second asks for the one site the popup is
  open on. The third, on the welcome page, asks for built-in AI chats the browser hasn't granted yet, filtered to
  the manifest's own list. A new automated check makes each ask come first in the click's own turn. This review
  also found that "Protect this site" used to wait for storage before asking, which Firefox refuses, so the button
  did nothing there. That's fixed.
- A team's own kinds come from the managed policy. A format turns into a pattern only from escaped literal
  characters and one character class per `#` or `@`, capped at 40 characters with no repeats or choices, and 50
  hostile formats stay linear under that cap. "Nearby" words are a plain text search in a 40-character window.
  Kind ids are made by Clotr and can't replace a built-in kind. Names are cut to 40 characters and shown with
  `textContent`. Words are kept as salted fingerprints in memory only, and nothing reports back to the
  organization.
- For pictures, Clotr reads only a photo's saved place, from EXIF or XMP in JPEG, PNG, WebP, HEIC, HEIF, AVIF or
  TIFF, and the file's name. The picture itself stays unread. The reader bounds every read to 256 KB, plus at most
  64 KB for one HEIC item, caps every loop, always moves forward, and has no recursion driven by the file. 2,000
  damaged files and 22 hostile ones all give nothing back and never hold a send. The place itself is kept only as a
  salted fingerprint, rounded to about 100 metres.
- Files that hold up a send fail open. A read that throws, or takes longer than 20 seconds, never holds the
  message.
- A send right after a page loads was found and fixed too. The settings and the salt used to arrive in two
  separate answers, so a word from the vault or a team policy couldn't be matched in between, and a message sent at
  that moment went out unchecked. Now they arrive together, and a send at that moment waits for them for up to 3
  seconds, then goes through as before if they still haven't come.
- No blocking issues.

## Scam protection and Clotr for Windows (1.3.0), plus two features held back
This covers "Is this a scam?", Tourniquet and Clotr for Windows' no-network guarantee, the pieces switched on for
everyone or shipped for the first time in 1.3.0. It also covers Look back and Extension check, which were reviewed
then and are still held back from the extension.
- "Is this a scam?" (`check.js`, `scam-signs.js`) has its own rule test beyond the generic ones. `check.html` loads
  only Clotr's own six scripts and no inline script, and the box you paste a message into has `autocomplete="off"`
  and `spellcheck="false"`, so the browser's own spell checker can't carry pasted scam text anywhere. `check.js`
  never writes to storage or calls `sendMessage`, and it has neither a `console.*` call nor a `fetch`, XHR, beacon
  or WebSocket. It reads the vault once to check your own saved details and never writes back. `scam-signs.js` takes no DOM and no `chrome.*`
  call, and returns only where a sign starts and ends and its name, leaving out the words it matched.
- Tourniquet's stored state, in `backup.js` and `sites.js`, is validated the same way wherever it's read. It's
  either a child or grown-up setting, or the 30 days after a scam with an end that's after its start and no more
  than 61 days away, and anything else is rejected outright. `content.js` only reads Tourniquet from a settings
  broadcast and never writes it. Nothing in it listens for a message from the page, so a hostile AI site has no
  path to Clotr's storage to plant a different setting in the first place.
- Look back is held back from the extension so far. Its code, in `lookback.js`, `lookback-core.js`,
  `lookback-worker.js` and `zip.js`, hands your picked export straight to its own worker as File objects rather
  than a copy of their bytes, and the worker reads them lazily as it unzips. The zip reader caps entries at
  200,000, the central directory at 64 MB, and how far one entry can inflate past its compressed size, aborting
  mid-stream past the limit. Look back's own reader adds caps on a chat's size, how far it peeks ahead, and how many
  pictures it lists. A rebuilt chat link is built from a validated ID and a fixed address rather than the export's
  own link text, so a tampered export can't turn into a convincing fake link.
- Extension check is held back so far too. `extcheck.js` and `extcheck-core.js` ask for the `management`
  permission in the same click that starts the check and hand it back in a `finally` block whether the check
  finishes or fails, so it's never held longer than that one look. What's installed is only ever compared, in
  memory, against the bundled reported-extensions list, and nothing about another extension reaches storage or a
  message.
- Clotr for Windows' no-network guarantee has two layers. `deny.toml` refuses to build at all if a networking
  crate, like `reqwest`, `hyper` or `tauri-plugin-http`, enters the dependency tree. A second test parses the
  *built* program's own list of what it imports from Windows and fails if anything networking-shaped shows up, such
  as `ws2_32.dll`, `wininet.dll`, or a socket or DNS call, which catches a dependency that slips in disguised. A
  further end-to-end suite runs the built app through its real screens and watches the operating system's own open
  sockets, expecting none.
- `tools/auto-update.ps1` and `.sh`, dev-only scripts that never ship, do reach the network. They run `git fetch`
  against the project's own GitHub remote to keep a local clone in sync, fast-forward only and never on a branch
  with uncommitted changes. That's expected, and separate from the rule for the shipped extension and app, since
  nothing a person installs ever makes this call.
- The test that checks console output never includes a detected value, a draft or a file name used to read its
  list of files by hand, and `check.js`, `scam-signs.js`, `backup.js`, `sites.js`, `editor.js` and `zip.js` weren't
  on it. So a `console.log` added to one of them later wouldn't have been caught by this specific test, though the
  broader "100% local" and "no innerHTML" tests already scan every file generically. None of the six logs anything
  it shouldn't, and the test's list now names them too.

No blocking issues. One thing to watch rather than fix now is that nothing today lets a page send Clotr's content
script a message it acts on, so Tourniquet's storage has no path from a hostile page to tamper with. If a future
feature ever adds one, it should come with a test proving Tourniquet can't be reached through it, the same way the
vault probing in finding 23 got one.

## Events a page's script can cause
A security scan of 1.2.1 found two more ways around finding 23, and a second look found a few close relatives. The
browser marks some events trusted even when only the page's own script acted, so `isTrusted` alone doesn't prove a
person did anything. Each of these let a hostile or compromised AI page put guesses in its chat box, get Clotr to
check them, and watch for Clotr's element to appear, with nobody typing.
- `document.execCommand("insertText")` fires a trusted `input` event, though never a `beforeinput`. Typing now
  counts only right after a trusted `beforeinput`, which every real edit fires first. This one needed no action from
  the person at all.
- A page could fake the end of an input-method composition, which Clotr follows with a fresh check of the box. Only
  a composition the browser itself starts counts now, and an end matters only during one.
- A file pick's `change` event is trusted, but a page's own listener could put its guess files on the input before
  Clotr read them. Clotr now reads the pick at the browser's own `input` event, where its listener runs first.
  Made-up `change`, `drop` and `paste` events were already ignored, and a real drop or paste can't be edited by
  the page.
- `form.requestSubmit()` gives a trusted `submit`. Clotr already checked one only right after a real Enter or a real
  click on a send button, but a page could use that moment to swap its guesses in and put the person's text back.
  A submit is now checked only while the box holds exactly what it held at that key or click.
- A made-up Enter key could switch off the check of a phone keyboard's new line. Only real keys count for that now.

Every one of these changes only skips a check, so none of them can hold a message. A send a page's script starts
with nobody acting, or after changing the box, goes through unchecked. Checking it is exactly what would answer the
page's guesses, and the person's own text was already checked at their Enter or click. Clotr's warning and dialog
listen only on their own buttons inside a closed shadow root, which a page can't reach to fake a click or a key.
Checked by e2e SEC2b, SEC2c, SEC4-swap, SEC6, SEC7 and SEC8, each seen failing before its fix.

## Accepted limits
- A hostile AI site can defeat Clotr on its own pages. It can remove the warning, though Clotr then notices and
  stops holding messages there, as finding 20 above describes. It can imitate Clotr's warning, or cover its
  buttons so a click lands elsewhere. A click it steers that way can't make Clotr warn less on every site,
  though. A choice like "stop warning me", "fine to share" or "Just count it" only applies after a yes on Clotr's
  own page, which opens in its own tab beside the chat. Planting fake *sent* entries by scripting its chat box
  doesn't work, per finding 22 above. Clotr's warnings never ask you to type anything, so an imitation can't
  collect details, and the site can't learn anything it doesn't already receive, since it is the destination the
  text is going to anyway. There are a few narrow exceptions, each needing you to act. Text the site adds to your
  chat box while you type, or before you press Enter, gets checked along with yours. It sits in your box, though a
  page could style it so it's hard to see. A reply gets checked once per message you send, so the site can test
  one guess per message against your vault, per finding 23 above. And in a tab Clotr joined after the page had
  loaded, right after an install or update, a page that set its own listener first can still swap its files into a
  file you pick, until the tab is reloaded. Fixing these would need browser support that doesn't exist for
  extensions.
- Bandage only sees what the page has loaded. Some sites load older messages only when you scroll up, so a label
  in a message that isn't loaded yet can't be seen. After a reload, or when you open an older chat, a new detail
  can end up reusing that same label, giving one label two different details in the same chat. Clotr doesn't
  scroll sites to load more, but scrolling up to the start of the chat first avoids the problem.
- Fingerprints of short values are harder to guess than they were, and still guessable by someone with full access
  to this browser profile, who can try every candidate for a value you saved to your vault or that landed in your
  history. A 4-digit PIN takes minutes now, where it used to take under a millisecond. A word on your own watch
  list is still fingerprinted the fast way, since `patterns.js` checks it against every span of text while you
  type, and that word was yours to choose in the first place. "What Clotr stores" discloses all of this. From 1.3.0
  the same page also covers a photo's place, rounded to about 100 metres, though that same person could just open
  the photo itself.

## Automated from now on
`npm test` runs a ReDoS fuzz of every pattern, performance budgets and the false-alarm corpus, and fails on a
network call, `innerHTML` or remote code, within the manifest's scope. `npm run test:e2e` checks that nothing typed
is ever stored with Z1, fail-open behavior with FO1-FO4, and accessibility with A11Y1.
