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
   look-alike digits, then fingerprints what it finds.
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
   hover-to-peek bubble.
10. `content.js` watches what's typed, runs detection, holds or lets through a send, carries out the person's
    choice, and reports what happened to the background.

### Messages between a page and the background

A content script never touches `chrome.storage` directly; it asks the background for everything through messages.

- A tab sends `clotr:getSettings` when Clotr starts there, and gets back its responses, the vault's fingerprints,
  the salt, and anything a team's policy adds.
- `clotr:setResponses` carries a choice to warn less (or more) about one kind of detail.
- The background sends `clotr:settingsChanged` to every open tab when a setting they rely on changes.
- `clotr:vaultAdd` and `clotr:vaultUpdate` are the only way anything reaches the vault, sent only from Clotr's own
  pages.
- A tab sends `clotr:pictureNoted` to tell the background the "Clotr can't read pictures" note was shown once on
  this site.
- Clotr's own pages send `clotr:importBackup` to tell the background to load a "move to a new computer" file.
- A freshly loaded content script sends `clotr:hello` to announce itself, so an older copy already on the page
  steps aside after an update instead of running twice.

### The rest

- `background.js` is the service worker. It's the only writer of history and the fingerprint salt, and that
  includes clearing history, which goes through the same queue as everything else it writes.
- `sites.js` holds what the background and Clotr's own pages share: the built-in site list, the email and chat apps
  people switch on themselves, and how a team's browser policy is applied.
- Clotr's own pages (the popup, the vault, the full report, Settings, the guided setup, and a handful of
  single-purpose pages opened from them) are plain HTML, CSS and JavaScript with no build step.
- `_locales/` holds the Spanish strings; pages mark text with `data-i18n` and keep the English readable in the HTML.
- `icons/` is generated from the brand tile in `tools/brand.js`. The README image, social card and store pictures
  come from that same tile, through `npm run brand`.

The website lives in `site/`, written by hand as `index.html` and `style.css`. `npm run site` builds its generated
assets: the screenshots, the favicons and the animated map. It loads nothing from other sites and runs no script
of its own.

## Storage

Everything Clotr stores stays on the device: settings, the vault as one-way fingerprints, and history as metadata
only (time, site, kind, severity and what happened), never a detected value. The background is the only writer, and
cleans every record against the same rules on the way in, whether it came from a chat page or from loading a backup.

## Tests and tools

- `npm test` runs the detection unit tests, plus the automated checks that enforce the project's guard rails, like
  no network code, no values in logs and classic scripts only.
- `npm run lint` runs Prettier and ESLint. `npm run format` fixes formatting automatically.
- `npm run test:e2e` drives a real browser with the extension loaded against fake AI pages, blocking every other
  request.
- `npm run package` builds the release zip and its SHA-256, reproducible from the tagged source.
