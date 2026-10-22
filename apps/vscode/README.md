# Clotr for VS Code

Version 0.1.0.

Clotr checks ordinary open files for credentials as you edit. It shows a masked finding because AI assistants in VS Code
can read files you have open. Personal details stay quiet unless you turn on `clotr.personalDetailsInFiles`. Secret
files such as `.env` and private keys stay quiet. If one isn't ignored by Git, Clotr shows one workspace note with an
option to add the file to `.gitignore`.
Clotr also checks your clipboard or a selected piece of text before you paste it into an AI assistant, then offers to
copy a cleaned version with the engine's Bandage placeholders.

The Explorer's Clotr view lists each open file with findings and shows each finding's kind and masked form. Select a
finding to open its file at that range. The Clotr status bar item opens Explorer. The minimum severity setting starts
at medium.

The editor plugin reads a `.clotrignore` file at the repository root for paths and for made-up values you want it to
skip. A matching file is skipped silently. A finding whose value matches a listed fingerprint is skipped.

Use **Clotr: Check what I send to AI coding assistants** to set up or remove Clotr Guard for Claude Code, Cursor,
Gemini CLI, Codex CLI or Windsurf. It shows which settings folders it finds and previews the exact CLI changes before
asking to apply them. Choose the Git pre-commit check to add it to the open workspace.

Setup uses Clotr Guard from `npm install -g clotr-guard` when it finds one, and the copy inside the extension
otherwise. An update moves the extension to a new folder, so Clotr asks before setting Guard up again.

Clotr runs on your device and makes no network calls. It keeps a random salt, ignored finding fingerprints and the list
of files you turned off in VS Code workspace state. It does not save detected values. Files above 1 MiB, binary files,
secret files, and the configured skip patterns are left alone.

## Stable and preview

Every feature below has tests that run whenever the code changes. A stable one is settled, and a preview one works
but may still change.

| Feature | Status | Tests |
| --- | --- | --- |
| Warnings for credentials in open files | Stable | [vscode.test.js][vscode-tests] |
| Personal details in open files, off until you turn them on | Stable | [vscode.test.js][vscode-tests] |
| Ignore this one and Turn off for this file | Stable | [vscode.test.js][vscode-tests] |
| Secret files stay quiet, with one note when Git doesn't ignore one | Stable | [vscode.test.js][vscode-tests] |
| Checking the clipboard or a selection, with a cleaned copy | Stable | [vscode.test.js][vscode-tests] |
| The Explorer view and the status bar item | Stable | [vscode.test.js][vscode-tests] |
| Setting up Clotr Guard | Preview | [vscode.test.js][vscode-tests], [guard.test.js][guard-tests] |
| No network calls | Stable | [rules.test.js][rules-tests] |

Guard setup is a preview because hooks that use the copy inside the extension stop working when the extension
updates, until you choose Set it up again.

[vscode-tests]: https://github.com/clotr-app/clotr/blob/main/tests/vscode.test.js
[guard-tests]: https://github.com/clotr-app/clotr/blob/main/tests/guard.test.js
[rules-tests]: https://github.com/clotr-app/clotr/blob/main/tests/rules.test.js

## Building it

The extension package includes its engine bundle, Guard files, and the license. VS Code's prepublish step builds them
inside the extension folder, so the `.vsix` runs without files from the Clotr checkout.

To try Clotr from a clone, run `node apps/vscode/build.js`, then run `npm run vscode:try` and copy the printed command
into a terminal with VS Code's `code` command available. This opens the extension from the clone in an Extension
Development Host.

Package it from `apps/vscode` with `npx --yes @vscode/vsce package --no-dependencies`.
