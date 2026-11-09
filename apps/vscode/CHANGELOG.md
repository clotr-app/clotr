# Changelog

What changed in each version of Clotr for VS Code, Cursor, Windsurf and VSCodium.

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
