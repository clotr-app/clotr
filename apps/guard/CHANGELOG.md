# Changelog

What changed in each version of Clotr Guard and Clotr MCP, the MCP server that comes with it.

## 0.1.4 (2026-11-27)

Known issue: a command that copies the example env file is stopped when it also has `alias`, `function` or `hash`
in it, even in quotes, like `alias ll='ls -la'; cp .env.example .env`. 0.1.3 runs it. Run the two parts one at a
time.

- A copy of the example env file that renames the copy command first, like `alias cp=cat; cp .env.example .env` or
  `function copy { gc $args[1] }; copy .env.example .env`, is stopped. 0.1.3 ran it and printed the real `.env`.
- Copying the example env file with a comment or a second line after it, like
  `Copy-Item .env.example .env  # first run only`, runs again in PowerShell and Cursor.
- The shell check stops more reads of a secret file. It follows a `cd` or a variable earlier in the command, like
  `cd .kube && cat config`, and reads `xargs`, `find -exec`, `Start-Process` and inline code like
  `python -c "print(open(\".env\").read())"`.
- More ways of printing the environment are stopped, like `env > e.txt`, `sudo env` or `docker exec app env`, and
  `printenv PATH` runs again.
- A commit message that mentions a secret file, like `git commit -m "read PORT once; type .env values"`, runs. So
  does a wildcard like `cat config*` that matches no secret file.
- A file read through a tool server, like GitHub's `get_file_contents` on `.env`, is stopped by its name.
- Hook input that never ends, a Git that doesn't answer and a network share that stalls get an answer in time,
  where 0.1.3 could hang.
- A stopped prompt sent again goes through only in the session that showed the warning, and an error inside Guard
  stops the prompt instead of letting it through.
- `clotr-guard check` checks every file it's given, finds a key in a UTF-16 file with no byte order mark, and shows
  less of each value.
- The engine is 1.6.4, up from 1.6.1. A password in a link like `smb://sam:hunter2!@nas.example.org/share` is found.

Every change in detail is in `apps/guard/docs/0.1.4-details.md` in the repo.

## 0.1.3 (2026-11-08)

This fixes the known issue in 0.1.2. Commands that only mention a secret file, like `Copy-Item .env.example .env` or
`rg "credentials" README.md`, run again, and a command that reads one is still stopped.

- A search's pattern isn't taken for a file it searches, in rg, Select-String and findstr, and that includes
  `findstr //i` run from Git Bash.
- Copy-Item's destination isn't taken for a file it copies, even with a splat set in the same command. Where Guard
  can't tell which word is the destination, it reads the command the way 0.1.2 did.
- The Dockerfile is gone from the repo. Install Guard from npm.

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
