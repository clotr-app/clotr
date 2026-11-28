# Changelog

What changed in each version of Clotr for VS Code, Cursor, Windsurf and VSCodium.

## 0.3.2 (2026-11-28)

Known issue: Guard stops a command that copies a template file like `.env.example` when the command also has `alias`,
`function` or `hash` in it, even in quotes, like `alias ll='ls -la'; cp .env.example .env`. 0.3.1 runs it. Run the two
parts one at a time.

- Guard is now 0.1.4. A copy that renames the copy command first, like `alias cp=cat; cp .env.example .env`, is
  stopped, and so are more reads of a secret file, like `cd .kube && cat config`. Copying the example env file with a
  comment after it runs again in PowerShell and Cursor.
- After you update, Clotr points the Guard hooks it set up at the new version by itself, with the options they had,
  so your assistants keep their check without being asked again.
- The engine is 1.6.4, up from 1.6.1. Open files get a warning for a password in a link, like
  `smb://sam:hunter2!@nas.wibblecorp.io/share`, a password under a name like `dbPassword:`, and API tokens in 19 more
  formats.
- Fewer wrong warnings, like for `secret: true` in backticks or a note under `password_ref:`.
- Closing a file clears its warnings from Problems, the Clotr view and the status bar, and "Ignore this occurrence"
  ends with it. In 0.3.1 both lasted until the window reloaded.
- A long `clotr.skipList` pattern full of `*` no longer holds up checking a file.
- With personal details in files off, a driver's licence, insurance or medical record number or an IP address isn't
  marked any more. Card and bank numbers still are.
- The icon's corner mark is now a steel disc with brackets.
- The code is in readable files grouped by what they do now. Nothing about how it works for you changes.

Every change in detail is in `apps/vscode/docs/0.3.2-details.md` in the repo.

## 0.3.1 (2026-11-08)

- Guard is now 0.1.3, so a command that only names a secret file, like `Copy-Item .env.example .env`, runs again. It
  still stops commands that read one.
- After you update, say yes when Clotr asks to set Guard up again, so your assistants use the new one.

## 0.3.0 (2026-11-07)

Known issue: Guard 0.1.2 can stop a harmless command that only names a secret file, such as
`Copy-Item .env.example .env`. I'm fixing that in the next Guard release, and until then you can run those commands in your own terminal.

- Guard is now 0.1.2, with the engine from Clotr 1.6.1. It stops more secret-file reads, like a `.env` name split up by quotes, escapes or carets.
- If an update leaves Guard's hooks pointing at the old version, Clotr asks to set Guard up again until you do.
- "Clotr: Turn checking back on for this file" undoes "Turn off for this file".
- Check selection checks every selection when you have more than one cursor.
- Open files, Check clipboard and Check selection say when part of the text wasn't checked.
- Move to .env reads an unsaved `.env` and tells you when Git doesn't ignore it.
- Add to .gitignore writes to a nested repository's own file.
- Without the Git extension, Clotr reads `.gitignore` folder rules and leading slashes the way Git does.
- A file that only mentions a service-account key keeps its other findings.
- Editing `.clotrignore` checks your open files again.

Guard's changes are in [its changelog](https://github.com/clotr-app/clotr/blob/main/apps/guard/CHANGELOG.md) and
the engine's in [the engine changelog](https://github.com/clotr-app/clotr/blob/main/apps/engine/CHANGELOG.md).
