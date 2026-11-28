# The extension's code

VS Code loads `extension.js`, one folder up. Its `activate()` builds each piece from the files here in start-up order,
then registers every command, the findings view, the quick fixes and the events. Each file below does one job, and its
name says which.

## Folders

| Folder | What it does | Files |
| --- | --- | --- |
| `src/` | What every folder uses: Guard's code, the engine, the settings, the editor's name and its language, and whether a path is inside a folder | `bundled-guard.js`, `vscode-engine.js`, `clotr-settings.js`, `editor-name.js`, `path-within-folder.js` |
| `open-files/` | Checks the files a person has open | `skipped-files.js`, `project-clotrignore.js`, `ignore-once.js`, `open-file-findings.js`, `check-open-file.js`, `recheck-open-files.js` |
| `findings-and-quick-fixes/` | Shows what was found, in the list and the status bar, and the fixes offered on it | `findings-view.js`, `quick-fixes.js`, `move-to-env.js` |
| `commands/` | The commands a person runs from the palette | `check-clipboard-and-selection.js`, `welcome-and-try-it.js` |
| `secret-files-and-gitignore/` | The note when a secret file isn't in `.gitignore` | `gitignore-file.js`, `secret-file-note.js` |
| `guard-setup/` | Sets up Guard, and fixes its hooks after an update | `programs-on-path.js`, `run-guard-command.js`, `set-up-guard.js`, `guard-hooks-after-update.js` |

`guard/` sits beside `src/` in the packaged extension. `build.js` writes it, and hooks on people's computers point into
it, so it stays where it is.

## Where each command lives

| In `package.json` | File |
| --- | --- |
| `clotr.tryIt` and the walkthrough's Try it step | `commands/welcome-and-try-it.js` |
| `clotr.checkClipboard`, `clotr.checkSelection` and the editor's right-click menu | `commands/check-clipboard-and-selection.js` |
| `clotr.setupGuard` | `guard-setup/set-up-guard.js` |
| `clotr.turnOnFile` | `extension.js` |
| the `clotr.findings` view | `findings-and-quick-fixes/findings-view.js` |
| the four `clotr.*` settings | read in `clotr-settings.js` |

The quick fixes run commands that aren't in the palette. `clotr.addToClotrIgnore` is in `quick-fixes.js` and
`clotr.moveToEnv` in `move-to-env.js`. `clotr.ignore`, `clotr.turnOffFile` and `clotr.focusView` are in
`extension.js`. Every command is registered in `extension.js`, so it's the one place to compare with `package.json`.

## Testing it

From the repo root, `node --test tests/vscode.test.js` runs the extension against a stand-in for VS Code.
`tests/load-vscode-extension.js` finds the code files by reading this folder and hands each one the stand-in, so a new
file is tested and packaged without being listed anywhere. `npm run vscode:try` prints the command that opens it in
VS Code.
