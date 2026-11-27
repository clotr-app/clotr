# Changelog

What changed in each version of Clotr MCP. It ships inside Clotr Guard's npm package, so each version names the Guard
release that carries it.

## 0.1.4 (2026-11-27)

Comes with Clotr Guard 0.1.4, which carries engine 1.6.4.

- `clean_text` hides a password in a link with a login, like `smb://sam:hunter2!@nas.example.org/share`, where 0.1.3
  left it in the text.
- A finding's masked form shows none of a password and at most a quarter of anything else, like `AK…3N` for a key.
- A call too large for one line, or sent in a batch, now gets an answer with its own id, so the assistant isn't left
  waiting for its timeout.
- When the engine runs out of time, `clean_text` also says part of the text wasn't checked, in a `note`.
- The server gives MCP's own version, the one in its registry listing, instead of Guard's package version. Both are
  0.1.4 in this release.

## 0.1.3 (2026-11-08)

Comes with Clotr Guard 0.1.3. The MCP server itself didn't change.

## 0.1.2 (2026-11-06)

Comes with Clotr Guard 0.1.2.

- Each tool has a title and read-only annotations, and `initialize` tells the assistant when to call each one.
- When the engine runs out of time, `check_text` and `clean_text` return `truncated: true`, and `check_text`'s verdict
  says part of the text wasn't checked.
- `clean_text` hides the values from the same scan it lists them from.
- `is_secret_file` judges a path on another computer by its name without looking it up, and reads a path with a
  trailing separator as the file.
