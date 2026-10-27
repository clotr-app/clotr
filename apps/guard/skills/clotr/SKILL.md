---
name: clotr
description: Use when Clotr Guard stops a prompt, a file read, a shell command, a tool call or a commit, or before text that might hold a credential leaves this computer.
---

# Working with Clotr Guard

Clotr Guard runs on this computer. Its hooks check prompts, file reads, shell commands, MCP tool calls and Git commits
for credentials, and for personal details when the person turned that on, and they can stop any of them. A message
from Clotr names the kind of thing it found and where it was found, without showing any part of the value.

## When Clotr stops something

Tell the person what was stopped, using the kind and location from Clotr's message, and let them decide what happens
next. Never repeat or reconstruct any part of the value. The choice is theirs, so leave the check in place.

- Don't try another way to get the same text. That covers reading the file again, reading it with another command or
  tool, copying or encoding it, printing the environment, and committing with `--no-verify`.
- Never print, echo or log a value Clotr flagged, and don't ask the person to paste it into the chat.
- For a secret file such as `.env` or a private key, work from the variable names or an example file like
  `.env.example`.
- If Guard stops a content search, it names the secret file and gives a glob that leaves it out. Search other files
  with that exclusion, and don't try to get the named file's text another way.
- If a commit is stopped, say which file Clotr named and let the person take it out of the commit.

A stopped prompt goes through if the person sends it again within two minutes with the same findings. A new finding
pauses it again. Some checks ask the person instead of stopping. Claude Code asks before reading an ordinary file with a credential in it, and Claude Code
and Cursor ask before a shell command or MCP tool call whose arguments hold one. That answer is the person's too.

Two messages mean the check didn't cover everything. One that starts "Clotr couldn't check this" means the check
failed and the action went ahead unchecked, so tell the person. "Clotr checked the first 256 KiB" means the rest of
that file wasn't checked.

## Clotr's MCP tools

When the `clotr` MCP server is set up, it runs on this computer and answers only when you call it. It doesn't block
anything, so act on what it returns.

- Call `check_text` with `text` before text leaves this computer or goes to another tool. It returns `findings`, each
  a `kind` and a `masked` form, and a `verdict`. If there are findings, stop and ask the person.
- Call `clean_text` with `text` for a copy with each finding replaced by a placeholder. It returns `text` and the
  `replaced` findings. The text around each placeholder is unchanged, so read the copy before you use it.
- Call `is_secret_file` with a `path` before reading a file. If `is_secret_file` comes back `true`, don't read it.

Set `include_personal_details` to `true` on `check_text` or `clean_text` to check details like email addresses too.
Credentials are checked either way. Each call takes up to 64 KiB of text.
