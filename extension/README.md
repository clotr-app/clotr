# The browser extension

This folder is the extension as the browser loads it. Files the browser looks for by name, like `manifest.json`
and `_locales/`, stay at the top, and the rest sit in folders named for what they do.

| Where | What's in it |
| --- | --- |
| `manifest.json` | What the browser reads first. |
| `background.js` | Loads the worker: the two lists, the site files, the engine, the worker's files and its parts in `background/`. |
| `extension-files.js` | The list of the files outside the engine that load in a fixed order. It names the site files, the worker's own files and the scripts that run in a chat page. |
| `engine/` | The engine, which finds private details in a text. It has its own map. |
| `clotr-pages/` | Clotr's own full pages, one folder each, named for what the page says at the top. `look-back/`, `extension-check/` and `office-training/` are held back. |
| `clotr-pages/vault/` | What should I protect?, which is also the welcome page. Every other page builds on its `vault.css`. |
| `clotr-pages/exposure-report/` | Your exposure report, which the popup opens. |
| `clotr-pages/what-clotr-stores/` | What Clotr stores, with Move to a new computer. |
| `clotr-pages/set-up-for-someone/` | Set Clotr up for someone, with the PIN and Tourniquet. |
| `clotr-pages/scam-check/` | Is this a scam?, and the scam signs it reads. |
| `clotr-pages/practice/` | Practice spotting scams. |
| `clotr-pages/warn-less/`, `policy-applied/`, `share-clotr/`, `how-ads-follow-you/` | The small pages: warn less on every site, an organization's policy, sharing Clotr and how ads follow you. |
| `popup/` | The toolbar popup. `popup.css` holds the colours and type every page shares. The popup's script comes in six parts that load in the list's order. `popup-state.js` has the labels and the element builders, `popup-this-site.js` the card for the site you're on, `popup-overview.js` the Overview and Activity table, then `popup-settings.js`, `popup-tourniquet.js` and `popup.js` with the tabs and start-up. The parts share names like one file, and the lines at the top of each tell lint which. |
| `background/` | The worker, which runs with no window, in eight parts, in the list's background group. Chrome loads them from inside `background.js`, and Firefox and Safari load them from the manifest, just before `background.js`. `worker-storage.js` loads first, so it sets the few names several parts use. It also handles session storage, one write at a time and the team's policy, and `settings-for-sites.js` works out what each site gets. `history-log.js` keeps the salt and the history, and `toolbar-icon.js` the icon and badge. `start-on-sites.js` starts Clotr on new and added sites. Then come `install-and-update.js`, `vault-and-learning.js` and `worker-messages.js`, which answers the pages and the popup. Each part takes the names it alone uses from `Clotr` and `ClotrSites` at its top. |
| `sites-and-policy/` | Which sites Clotr runs on and what a team set, loaded by the worker, the popup, the pages and the Windows and Android bundle. `protected-sites.js` holds the site lists and asks the browser for each one. `ai-site-spotting.js` spots an AI chat Clotr doesn't know yet, `tourniquet-rules.js` holds Tourniquet, and `team-policy.js` reads a team's policy. Each is wrapped and adds its names to `ClotrSites`, in the list's sitesAndPolicy order. `helping-someone.js` is the PIN lock and the stricter setup for someone you help. |
| `on-websites/` | The scripts the browser runs inside an AI chat page, after the engine, in the list's chatPage order. `attached-files.js` reads an attached file as text, and `attached-pictures.js` tells a picture from a document. `warning-styles.js` holds the warning's look, `chat-box.js` finds the box a person types in, and `warning-ui.js` draws the warning. `content.js` watches typing, pasting and sending, and decides when to warn. `commands.js` loads between them from the top folder, since the engine plan owns it. |
| `one-clotr/` | The link to Clotr for Windows. Held back, so the shipped package leaves it out. |
| `page-parts/` | Pieces more than one of Clotr's own pages loads, like the page's translation, Report a problem, Quick exit and the mind map. |

Every path inside the extension starts at this folder, written with a leading `/` (`/one-clotr/one-clotr-bridge.js`),
so a page can move into a folder without changing what it loads.

To change either list, edit it, then run this.

```
npm run engine-files     # writes the manifest's content scripts and each page's engine script tags
```

`npm test` runs `tests/extension-files.test.js`, which fails if a list, a page or any path inside the extension has
fallen out of step.
