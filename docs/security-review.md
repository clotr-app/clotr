# Clotr security review (v0.9.16)

This review covers everything in `extension/` plus the update tooling in `tools/`. It works through code review of
every entry point, backed by automated checks that now run on every change, listed at the end.

## Found and fixed
| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| 1 | **ReDoS in the email pattern**: unbounded repeats backtracked quadratically; 20k characters like `a-a-a-…` took ~3 s | Any page (or a pasted log) could freeze typing and Enter | Parts bounded by their real limits (local part 64, domain 253, label 63) | Unit "no pattern is slow on hostile text" (fuzz of every pattern) |
| 2 | Same class in the internal-hostname pattern (~0.3 s per 20k characters) | Smaller freeze | Labels bounded to 63, at most 8 | Same fuzz |
| 3 | Same class in the street-address pattern (4 s per 40k characters of number words) | Enter froze | Spelled-out house numbers capped at 8 words (0.9.7) | Unit budget test, e2e PERF1 |
| 4 | After an update, the orphaned copy's dialog couldn't close and blocked Enter | The chat could get stuck | Extension calls can't throw into the UI; the orphaned copy only warns (0.9.5, 0.9.9) | e2e FO1–FO4 |

## Reviewed, no change needed
- Clotr sets no `externally_connectable` and no web-accessible resources, so a web page can't message Clotr or
  load its pages. The background only accepts messages from Clotr's own scripts, checked through `sender.id`, and
  it validates every write: events are rebuilt field by field through `sanitize`, vault entries must be
  fingerprint- or format-shaped through `cleanVaultEntry`, and type ids must match `^[a-z_]{2,40}$`.
- The dialog and notice live in closed shadow roots, so page scripts can't read them or press their buttons.
  Synthetic events don't activate buttons, and the page has no reference to them in the first place. Detected
  values are masked in the UI regardless.
- The fingerprint salt reaches only Clotr's content-script world, which is isolated from page scripts, and
  extension pages. "What Clotr stores" keeps it hidden from view.
- There's no remote code and no network call. Clotr never uses `eval`, `Function` or `innerHTML`, which a test
  enforces, and the only `fetch` reads the extension's own `manifest.json` for the local update check, also
  enforced by a test.
- Permissions cover the built-in AI sites only. Any other site needs the person to click "Protect this site" and
  approve it as one optional host permission, narrowed to the chosen section on a shared host.

## Added later (v0.9.27–0.9.31)
| # | Finding | Fix | Test |
|---|---------|-----|------|
| 5 | Invisible or look-alike characters from copied text (no-break spaces, zero-width spaces, full-width digits…) hid leaks | Text cleaned before checking; matches map back to the original | unit + e2e UN1; rule: no raw invisible/bidi characters in shipped files |
| 6 | Paste-then-Enter sent before the warning could be read | "Just sent" after a confirmed send | e2e FS1–FS3 |
| 7 | Word/Excel/PowerPoint attachments were never read | Unzipped with hard zip-bomb caps; fail open | e2e R8d/R8x/R8z |
| 8 | An attached file's name was logged | Only the extension is logged | rule: no values/drafts/file names in logs |
| 9 | PDF parsing on attacker-controlled files: a regex stream finder took 24 s on 900 KB of unclosed dictionaries | Linear, bounded scanners (indexOf + capped windows); inflation capped | unit growth tests; e2e R8p/R8q/R8r |
| 10 | Office documents: the XML tag stripper (`/<[^>]*>/g`) took 54 s on 600 KB of `<a <a <a…` (under every size cap) | One linear pass; entities looked up at most 10 characters ahead | unit growth test (`assertLinear`) |
| 11 | PDFs without stream lengths: up to 400 searches to the end of a 20 MB file | Search capped to 2 MB ahead and 50 such streams | e2e R8s |
| 12 | Clotr started after the page's scripts (document_idle): a site's own early window-level Enter handler could send before Ask before sending held the message | Start at document_start (built-in and user-added sites) | e2e EG1 (reproduced first); a test enforces it; real ChatGPT re-checked |
| 13 | Unlabeled send buttons bypassed Ask before sending | Composer buttons count as possible sends; Warn records only after the box empties | e2e UB1–UB3b |
| 14 | Vault fields could be kept in the browser's restore data or sent to cloud spell check | autocomplete/spellcheck off, cleared on pagehide | e2e V1s |
| 15 | Release packaging shipped every file in `extension/` except logs: a personal note, saved chat or editor backup left in the folder would have gone into a public zip | Only files git tracks are packaged (warning outside a git checkout); zips are reproducible with published SHA-256 | unit test: an untracked file with a phone number never reaches the zip |
| 16 | Sign-in pages on AI hosts: a username field, a password shown as text ("show password"), a one-time code or a sign-up form was watched like a chat box, so Clotr warned there and could record a fingerprint of your own login details | Inputs that are clearly sign-in fields (autocomplete hints, password/code names or labels, or in a form with a password field) are left alone | e2e LG1 (proven to fail before the fix; the chat box on the same page still warns) |
| 17 | Hide it (then called Cover it) could fail silently: on an editor that applies edits later (Kimi), the key stayed in the box (plus a hidden copy), the notice closed and history said *Hidden*, so a user would send it believing it was gone | Clotr waits for the editor's own update, records *Covered* only when the text really changed, and otherwise says "Clotr couldn't cover it here… delete it by hand" | e2e KM1, KM2 (both fail before the fix); verified on kimi.com |
| 18 | Tab state lost after an in-page navigation: sites that change their URL without reloading (a new ChatGPT chat, grok.com right after loading) made the background forget the tab, so the badge vanished and the tab looked unprotected | When a load completes and the tab is unknown, the background asks the tab's Clotr and restores its state from the answer | e2e HC4 (fails before the fix); verified on grok.com |
| 19 | The part of Clotr running inside AI pages could read all of Clotr's storage (your whole history across AI sites, every site's settings, the salt) and write any of it | Storage is locked to Clotr's own pages and worker; the in-page part asks by message for just what it needs (its own site's pause and mode, responses, vault, tips) and can only change responses through a checked message. Still true: it gets the vault fingerprints and the salt, because fingerprints are made inside the page so your typed text never leaves it; Firefox has no storage lock | e2e SEC1 (fails before the fix), a test enforcing that content scripts never use storage, Firefox 4/4 |
| 20 | A page that removes Clotr's dialog (hostile, or an app rebuilding the page) left you stuck with *Ask before sending*: every Enter was held and the dialog never showed; focus was left on the page, not the chat box | Clotr notices its box vanishing without it closing it: it stops holding messages on that page (fail open), gives the keyboard back to the chat box, and the self-check says "This page removed Clotr's warnings" (red ! badge) | e2e: stuck before the fix |
| 21 | Found while testing the fix above: since the storage lock (finding 19) a chat tab still starting up could miss a settings change (made in the popup meanwhile) until it was hidden and shown again | Changes are announced to every tab, not only those already registered | e2e SET1; EG1 caught it |
| 22 | Can a hostile page plant fake entries in your history by filling and emptying its own chat box with no user action? | Not in the test: a page that filled its box with a detail and emptied it by script, with no Enter or click from you, left nothing recorded as *sent* | e2e: kept as a regression test |
| 23 | **A page could probe your vault.** It could put guesses ("Emma? Liam?") in its own chat box by script, fire a fake input event or Enter, and watch whether Clotr's warning appeared; vault names only warn when they're yours, so that revealed them. The reply check was a second way: after one real send, the page could add guess after guess as "reply" text for 90 seconds | Clotr reacts only to events from the person (or a site's script right after a real key or click, via the browser's user-activation signal; where a browser can't tell, as before). The reply is checked once per message sent, after it has been quiet for 3 seconds | e2e SEC2, SEC3, RP5 |
| 24 | Clotr's pages could have connected out if a future change tried | Strict CSP: `connect-src 'self'`, `object-src 'none'`, … | rule + e2e CSP1 (proven to fail without it) |

Checked on real sites, logged out and with fake data: ChatGPT, Gemini and Grok all send nothing typed before Send,
verified with `tools/draft-leak-monitor.js` and a positive control.

- The full report, added in 0.9.37-0.9.40, only reads history. Fingerprints are used for counting and never shown,
  checked by e2e DSH2. Every value is set as text, never markup. The export is a file the person asks for, built
  without the fingerprint secret, so its fingerprints can't be matched against guesses, checked by e2e DSH3.
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
- A hotspot didn't remember its chat, found and fixed in the 1.2.0 review: after you opened another chat from the
  site's sidebar, a label still on the page from the chat you left could show the new chat's detail under the
  same label. Each hotspot now keeps its own chat and shows only that chat's detail, and all of them disappear
  the moment the chat changes. An e2e check caught this, and failed before the fix.
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
  the fingerprint is a hash of the policy itself, never of anything typed.
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
code or acts on the page, and a ReDoS and timing sweep on 50,000 characters of hostile input: letters, digits,
number words, misspellings, brackets, zero-width characters, and key and email look-alikes.

| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| 25 | **Reading a long run of digits was quadratic**: for every digit added to a run, the list-marker check ("1.", "2)") walked the whole run first; 40,000 digits took about a second (older than 1.0; 0.9.101 did the same) | A huge numeric paste froze the chat page for a second or more | The cheap tests first (at most 3 digits, a "." or ")" gap); the worst case of the sweep went from 958 ms to 130 ms (1.0.9) | Unit test: four times the digits take about four times as long |

- There are no new permissions since 0.9.101. The manifest only changed its name and version.
- Report a problem, in `report.js`, opens GitHub's issue forms with `noopener`. The address carries only the
  form, Clotr's version, the browser, and the AI site's name if the person ticked "Include this site". It never
  carries typed text, a stored value or a fingerprint. The false-alarm link names only the kind of detail, and a
  warning that reports are public comes before any choice.
- Leave it in and send only acts after the person's own click or Enter press on Clotr's dialog, which lives in a
  closed shadow root the page can't reach. It only triggers through whatever they used to send: their button or
  form, the site's own send button near the chat box for Enter, or Enter again. The page can't start it. Allowed
  details stay in memory for that one message, and nothing is stored.
- The reply window, added in 1.0.8, stays open up to 90 seconds to place cover-name hotspots in Clotr's own
  layer. It reads only text the page shows, and the vault's reply check still runs once per message, as finding
  23 above describes.
- The edit check, added in 1.0.7, ignores zero-width characters when it compares the chat box with Clotr's text,
  and changes no detection.
- Moving to a new computer reports what a file holds and what came back only as counts, like "3 vault items, a
  PIN", never a detail or the PIN itself.
- Names and addresses, settled in 1.0.6: the report address points at github.com/BilliamBaSH/clotr, and the
  Firefox add-on ID is clotr@billiambash. The public repo has to carry that name before Clotr goes public, so the
  address in the extension never points at someone else's repo.
- No blocking issues.

## The 1.3.0 candidate
This review covers the pieces that ask the browser for sites, run a team's own patterns, or read the files and
pictures people attach. It works through the code paths line by line, the automated checks that guard them, and
hostile-input tests.
- Asking the browser for sites happens in three functions only, each one enforced by a test, so a planted ask
  anywhere else, even through an alias or a bracket lookup, fails the tests. The three are email and chat apps by
  name from the built-in list, so nothing else can be asked for; the one site the popup is open on; and, on the
  welcome page, built-in AI chats the browser hasn't granted yet, filtered to the manifest's own list. A new
  automated check makes each ask come first in the click's own turn. Found and fixed: "Protect this site" used to
  wait for storage before asking, which Firefox refuses, so the button did nothing there.
- A team's own kinds come from the managed policy. A format turns into a pattern only from escaped literal
  characters and one character class per `#` or `@`, capped at 40 characters with no repeats or choices, and 50
  hostile formats stay linear under that cap. "Nearby" words are a plain text search in a 40-character window.
  Kind ids are made by Clotr and can't replace a built-in kind. Names are cut to 40 characters and shown with
  `textContent`. Words are kept as salted fingerprints in memory only, and nothing reports back to the
  organization.
- For pictures, Clotr reads only a photo's saved place, from EXIF or XMP in JPEG, PNG, WebP, HEIC, HEIF, AVIF or
  TIFF, and the file's name, never the picture itself. The reader bounds every read to 256 KB, plus at most 64 KB
  for one HEIC item, caps every loop, always moves forward, and has no recursion driven by the file. 2,000 damaged
  files and 22 hostile ones all give nothing back and never hold a send. The place itself is kept only as a salted
  fingerprint, rounded to about 100 metres.
- Files that hold up a send fail open: a read that throws, or takes longer than 20 seconds, never holds the
  message.
- Found and fixed: a send right after a page loads. The settings and the salt used to arrive in two separate
  answers, so a word from the vault or a team policy couldn't be matched in between, and a message sent at that
  moment went out unchecked. Now they arrive together, and a send at that moment waits for them for up to 3
  seconds, then goes through as before if they still haven't come.
- No blocking issues.

## Accepted limits
- A hostile AI site can defeat Clotr on its own pages. It can remove the warning, though Clotr then notices and
  stops holding messages there, as finding 20 above describes. It can imitate Clotr's warning, or cover its
  buttons so a click lands elsewhere. Planting fake *sent* entries by scripting its chat box doesn't work, per
  finding 22 above. Clotr's warnings never ask you to type anything, so an imitation can't collect details, and
  the site can't learn anything it doesn't already receive, since it is the destination the text is going to
  anyway. There are two narrow exceptions that need you to act: text the site adds to your chat box while you
  type gets checked along with yours, and you would see it in your box, and a reply gets checked once per message
  you send, so the site can test one guess per message against your vault, per finding 23 above. Fixing this
  would need browser support that doesn't exist for extensions.
- Bandage only sees what the page has loaded. Some sites load older messages only when you scroll up, so a label
  in a message that isn't loaded yet can't be seen. After a reload, or when you open an older chat, a new detail
  can end up reusing that same label, giving one label two different details in the same chat. Clotr doesn't
  scroll sites to load more, but scrolling up to the start of the chat first avoids the problem.
- Fingerprints of short values are guessable by someone with full access to this browser profile, and "What Clotr
  stores" discloses that. From 1.3.0 that includes a photo's place, rounded to about 100 metres, though that same
  person could just open the photo itself.

## Automated from now on
`npm test` runs a ReDoS fuzz of every pattern, performance budgets, the false-alarm corpus, and checks for no
network calls, no `innerHTML` and no remote code, within the manifest's scope. `npm run test:e2e` checks that
nothing typed is ever stored (Z1), fail-open behavior (FO1-FO4), and accessibility (A11Y1).
