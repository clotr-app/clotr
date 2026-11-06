# Changelog

What changed in each version of Clotr Guard and Clotr MCP, the MCP server that comes with it.

## 0.1.2 (2026-11-06)

Known issue: Guard can stop a few harmless commands that only mention a secret file, like `Copy-Item .env.example .env` or `rg "credentials" README.md`. I'm fixing it in the next Guard release. Until then, run them in your own terminal.

- A shell command is stopped when its check hits an internal error or the 10-second limit. A prompt is stopped when its
  check runs out of time, and a file read or MCP tool call is put to you, or stopped where the assistant can't ask.
- Guard never looks up a path on another computer (`\\host\share`, `file:` URLs). On Windows that can hand the other
  computer your sign-in hash, so these paths are judged by name alone.
- More secret-file reads are stopped: a search that reaches a git-ignored secret file, `grep -r` across a credentials
  folder, links, Windows short names and `/proc` environment files.
- Commands are read the way each shell reads them, so quotes, escapes and carets don't hide a path (`cat .e\nv`,
  `` gc `.env ``, `cmd /c type .e^nv`).
- A broad glob like `src/*` is stopped only when it can match a secret file in its folder.
- A filesystem MCP server's file reads are checked as reads of the files they name.
- With personal details off, the default, every personal kind stays out of the checks. Card and bank numbers stay
  checked like credentials.
- The commit check names a file it ran out of time on and stops the commit.
- A key among a megabyte of email addresses is found in about two seconds instead of 30 or more.
- A typical shell check takes about 0.44 s, up from 0.23 s.
- The engine is the one in Clotr 1.6.1, including Irish PPS and New Zealand IRD and NHI numbers.

Every change in detail is in `apps/guard/docs/0.1.2-details.md` in the repo.

## 0.1.1 (2026-10-27)

- `clotr-guard mcp` starts the MCP server, so `npx -y clotr-guard mcp` works.
- Cline hooks on macOS and Linux.
- Prompts piped from Windows PowerShell, which adds a byte order mark, are checked instead of passing unchecked.
- `clotr-guard check` says "Nothing found." in a terminal when it's clean and stays quiet in a pipe, and a mistyped
  tool or option gets a line that names it.
- A `.clotrignore` entry only takes hard-to-guess values.
- Hook block messages name the finding and where it came from without showing any of the value.
- The README's pre-commit config works.
