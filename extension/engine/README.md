# The engine

The engine finds private details in a piece of text and decides what to do about each one. The extension, its
workers and every app outside the browser run these same files.

| Where | What's in it |
| --- | --- |
| `files.js` | The list of the engine's files, in the order they load. |
| `rules/` | What each kind of private detail looks like. `rule-table.js` holds one entry per kind, and `value-checks.js` holds the checks most rules share. The folders under it sort the rules into `numbers/`, `personal/`, `ids-and-accounts/`, `key-formats/`, `passwords-and-codes/` and `api-tokens/`. |
| `vault/` | The words and details you saved, and finding them in a text. |
| `detect/` | Reading a text. It makes a cleaned copy and a second reading, finds keys typed in pieces and the text inside attachments, and `detect.js` runs the rules window by window. |
| `respond/` | What happens to a found value: its response, its fingerprint, covering it, a general form of it, Bandage's labels, and `decide.js`, which turns all that into a warning. |

Each file is a plain script wrapped in one function. A name another engine file needs goes on
`globalThis.ClotrInternal`, and the names apps and pages read go on `globalThis.Clotr`. A file can only use names from
files that load before it, and `tests/engine-files.test.js` checks that.

To change the list, edit `files.js`, then run these two commands.

```
npm run engine-files     # writes the manifest's content scripts and each page's engine script tags
npm run engine-bundle    # writes apps/engine/dist/clotr-engine.js
```

`npm run engine-files -- --check` changes nothing and fails if the manifest or a page has fallen behind the list.
