# Contributing to Clotr

Thanks for helping people keep their private details out of AI chats.

## The rules Clotr never breaks
These are checked automatically (`npm test`); a change that breaks one won't be merged.
- Only AI chat sites, never all websites. New AI sites go in `extension/ai-sites.json`.
- Everything runs on the device, with no network requests of any kind from the extension.
- Never store what someone typed. Only the kind of thing found, the site, the time, what they chose, and a salted
  one-way fingerprint.
- Never break the chat. Clotr informs and offers edits; if it fails, the message still goes through.
- Build the page with `createElement` and `textContent`; it never uses `innerHTML`, remote code or `eval`.

## Good first contributions
- Found a missing AI site? Add `{ "name", "matches" }` to `extension/ai-sites.json`, run `npm run sites`, and check
  the exact address the chat lives on.
- Found a missed detail or a false alarm? Add a test to `tests/patterns.test.js` that fails, then make it pass,
  using made-up values of the same shape instead of a real person's data or a real key.

## Working on the code
```
npm install
npm test            # detection tests and the rule checks above
npm run format      # formats JavaScript and CSS (Prettier); npm run lint checks formatting and lint
npm run test:e2e    # a real browser (Brave, Chrome or Edge) with Clotr loaded, against local test pages
npm run package     # the release zip (reproducible) and its SHA-256
```
- `extension/` is the extension (load it unpacked in `chrome://extensions` with Developer mode on).
- [docs/architecture.md](docs/architecture.md) covers how the parts fit together, what's stored and which checks guard it.
- Content scripts are classic scripts sharing code through `globalThis.Clotr` (no `import`/`export`).
- Every bug fix comes with a test that failed before the fix.

## How Clotr is built
I started Clotr in November 2025, first on my own, then with LM Studio's local models from around March 2026. In
September I began questioning the difference in application and deployment of Claude Code and Cline. One of my biggest
hurdles is Git management, or really Git at all, and none of my courses have introduced it yet. Since September I use
Claude Code, and it does a lot of the writing with me. I review and test everything before it ships, and I answer for
all of it. This is my way of bringing a helpful tool I use to bear for everyone.

## Your contribution and the license
Clotr is licensed under the [GNU AGPL-3.0-or-later](LICENSE), and its maintainer also offers a commercial license
to companies that want to use the code in closed products; that is how the project can pay for itself. So before
your first pull request is merged, you'll be asked to agree to the [Contributor License Agreement](CLA.md) (one
click, once). You keep the copyright to your work, and the agreement promises that everything contributed stays
available under the AGPL.

## Reporting problems
Use the issue forms (*False alarm*, *Missed something*, *Bug*). Describe the shape of a value, never the value itself.
For security problems, see [SECURITY.md](SECURITY.md).
