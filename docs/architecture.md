# How Clotr is put together

This is for contributors who want to know where things live, how the parts talk to each other, and what gets
stored. Security findings are in [security-review.md](security-review.md).

## The extension (`extension/`, the folder you load unpacked)

Content scripts are classic scripts with no `import` or `export`, and they share code through `globalThis.Clotr`.
They load in this order, which is kept the same in `manifest.json` and in `sites.js`'s `CONTENT_JS`. The background
also uses that same list to start Clotr on a site someone adds themselves.

1. `patterns.js` holds the detection patterns, from a plain regex to the number reader that catches a phone number
   or an ID spelled out, misspelled or mixed with digits, plus the vault's fingerprint matching.
2. `detector.js` runs every pattern over a message. It cleans the text first, stripping invisible characters and
   look-alike digits, then fingerprints what it finds. It gives up after ten seconds on one message
   (`DETECT_BACKSTOP_MS`) rather than let a huge paste run forever, and marks what it found so far as `truncated`.
3. `decide.js` turns a found detail into a response (warn, just count, or hold for a yes/no) and the words for it.
   It touches no page, storage or browser API, so every place it runs makes the same decision.
4. `attachments.js` reads text, PDF and Office files locally, with size caps, so an attachment is checked the same
   way typed text is.
5. `pictures.js` reads a photo's location if it's saved inside the file, and a scan's or filename's clues that it's
   an ID or a document. It never reads the words in a picture.
6. `commands.js` looks at a command copied from an AI chat for the shape of a known trick, without storing, sending
   or logging it.
7. `ui-styles.js` holds the CSS for Clotr's on-page warning and cover-name hotspots, kept in a closed shadow root.
8. `editor.js` finds the chat box (never a sign-in field) and edits it the way the page's own framework expects,
   falling back to a plain input event if that doesn't work.
9. `warning-ui.js` builds the warning dialog, the corner warning, and Bandage's cover-name hotspots with their
   hover-to-peek bubble. It also shows a quiet corner notice, once per message, when nothing turned up but the
   check itself gave up partway (`tellTruncated`), since staying silent there would read as "all clear" for the
   whole message.
10. `content.js` watches what's typed, runs detection, holds or lets through a send, carries out the person's
    choice, and reports what happened to the background.

### Messages between a page and the background

A content script never touches `chrome.storage` directly; it asks the background for everything through messages.

- A tab sends `clotr:getSettings` when Clotr starts there, and gets back its responses, the vault's fingerprints,
  the salt, and anything a team's policy adds: `teamHold`, when the policy requires *Ask before sending* for at
  least one kind, so an attached file's hold never ends on its own, and `holdFiles`, when the policy widens that
  hold to any finding in a file, not just one set to block. The policy itself, and the organization's name, never
  reach a tab.
- `clotr:setResponses` carries a choice to warn less (or more) about one kind of detail.
- The background sends `clotr:settingsChanged` to every open tab when a setting they rely on changes.
- `clotr:vaultAdd` and `clotr:vaultUpdate` are the only way anything reaches the vault, sent only from Clotr's own
  pages.
- A tab sends `clotr:pictureNoted` to tell the background the "Clotr can't read pictures" note was shown once on
  this site.
- Clotr's own pages send `clotr:importBackup` to tell the background to load a "move to a new computer" file.
- A freshly loaded content script sends `clotr:hello` to announce itself, so an older copy already on the page
  steps aside after an update instead of running twice.
- Opening Clotr's own Is this a scam? or How ads follow you page beside the chat goes through `clotr:openCheck` and
  `clotr:openTracking`: the content script can't navigate to an extension page itself, and neither message carries
  anything about the chat page it was sent from.

A tab starts scanning with the defaults the moment `content.js` loads, before its real settings arrive, so nothing
typed in that gap goes unchecked; what gets shown waits a little, though. A warning holds for up to three seconds
(`READY_WAIT_MS`, gated by `ready()`) for `clotr:getSettings`'s answer and the salt, so nothing already marked OK to
share, or set to Just count, gets warned about in the moment before they land. A second, faster channel opened as
soon as the tab starts (`chrome.runtime.connect({ name: "clotr:tab" })`) answers just the Bandage flag right away,
since Firefox can take a few seconds to wake a background worker it had suspended.

### The rest

- `background.js` is the service worker. It's the only writer of history and the fingerprint salt, and that
  includes clearing history, which goes through the same queue as everything else it writes. A page's settings
  and salt are answered outside that queue, since they only read (making the salt has its own lock): a page
  uses the defaults until its settings come, so they must never wait behind a slow write.
- `sites.js` holds what the background and Clotr's own pages share: the built-in site list, the email and chat apps,
  search engines and support-chat widgets people switch on themselves one at a time (`EVERYDAY_SITES`,
  `SEARCH_SITES`, `SUPPORT_SITES`, rendered in the popup by `renderMoreSites`), and how a team's browser policy is
  applied. None of them is an AI tool. A search box keeps its own wording (`warning-ui.js`'s
  `noticeWordsForSearch`) but loses Bandage and the reply check, while a support chat and an email or chat app get
  the same people-reading wording, since someone, or a bot, is reading on the other end.
- Everywhere I type (Settings' own switch, off by default) asks for the one broad `https://*/*` permission already
  named in the manifest's optional host permissions, and once granted, `background.js`'s `syncEverywhere` registers
  a second dynamic content script, `clotr-everywhere`, on every https page except the ones that already run Clotr
  another way: the built-in AI tools, search engines, and any site switched on by hand (`dedicatedMatches`). With
  no list naming the page in advance, it has to decide for itself whether a `<textarea>` or contenteditable region
  with a send-like control is really a chat box, never a plain input or a sign-in, address or payment field.
- Clean link treats a link's own tracking code as just another thing `patterns.js` can find and fix:
  `cleanableParamsOf` and `cleanShareLink` strip a share code (YouTube's `si`, Instagram's `igsh`, Reddit's
  `share_id`, …) or an ad network's click id (`gclid`, `fbclid`, any `utm_` tag) from a copied link, leaving
  everything else, including the `#fragment`, exactly as typed. A paste that's nothing but such a link gets its own
  wording in the warning ("Remove the share code"), and its "Why?" link opens `tracking.html`, Clotr's fixed page
  on how ads follow a shared link, through `clotr:openTracking`.
- Scam help is four pieces: `scam-signs.js` is a pure, portable pattern set (`scamSigns`) marking a message's
  warning signs under the FTC's four categories plus asking for a code or detail, reusing the engine's own ask
  labels so the two word lists can't drift apart; `check.js` is the Is this a scam? page that runs it locally over
  a pasted message, never storing or sending the text; the copied-command warning (`commands.js`'s `commandTrick`,
  read by `content.js`) is the same shape, for a command copied out of an AI chat that looks like a "press Win+R
  and paste this" trick; and `practice.js` is Practice, six made-up scam drills plus a "Spot the leak" round,
  checked by the real engine but kept only in the page's own memory.
- Tourniquet (`sites.js`) is a stronger setup for someone you're helping protect: a `child` or `adult` preset fixes
  every kind of detail to at least Ask or Warn, stored as one small `{ for, since }` record. A pure `tourniquetStep`
  decides when the 30 days (`TOURNIQUET_DAYS`) are up, and `background.js`'s `stepTourniquet` applies that and sets
  the end alarm. `after_scam` reuses the adult preset itself, so the two can never drift apart, for the 30 days
  after a scam.
- Clotr's own pages (the popup, the vault, the full report, Settings, the guided setup, and a handful of
  single-purpose pages opened from them) are plain HTML, CSS and JavaScript with no build step. One of those,
  `confirm.js`'s "Warn you less on every site?" page, exists because a chat page could otherwise restyle or cover a
  warning and steer a click onto a looser response: the background holds the choice (`askOnClotrPage`) and only a
  yes typed on this separate page actually applies it.
- The popup asks for optional `nativeMessaging` when you click Connect, and the browser talks only to the Windows app's pinned host.
- `_locales/` holds the Spanish strings; pages mark text with `data-i18n` and keep the English readable in the HTML.
- `icons/` is generated from the brand tile in `tools/brand.js`. The README image, social card and store pictures
  come from that same tile, through `npm run brand`.

The live website is `website-test/`, hand-written HTML and CSS, published with `npm run export-site`. Its one scripted
page, `try.html`, runs the engine's own
`patterns.js`, `detector.js`, `decide.js`, `scam-signs.js`, `page-notice.js` and `practice-data.js`, copied in from
`extension/` on export so a live trial can't drift from what the extension does; every other published page loads
nothing from another site and runs no script of its own.

## Storage

Everything Clotr stores stays on the device: settings, the vault as scrambled fingerprints, event metadata (time, site,
kind, severity, action and salted fingerprint), the same metadata for AI replies that mentioned your details
(`mentions`), and the names of unprotected AI sites it was opened on (`spotted`, names only, no pages or times). It
never stores a detected value. The background is the only writer, and cleans every record against the same rules on
the way in, whether it came from a chat page or from loading a backup.

## Tests and tools

- `npm test` runs the detection unit tests, plus the automated checks that enforce the project's guard rails, like
  no network code, no values in logs and classic scripts only.
- `npm run lint` runs Prettier and ESLint. `npm run format` fixes formatting automatically.
- `npm run test:e2e` drives a real browser with the extension loaded against fake AI pages, blocking every other
  request.
- `npm run package` builds the release zip and its SHA-256, reproducible from the tagged source.
