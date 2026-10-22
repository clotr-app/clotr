# Clotr Guard

Clotr checks text you send to an AI coding assistant from your terminal. It uses the same on-device engine as Clotr's
other apps. A clean prompt passes. Medium and high findings pause that prompt and show their kind and masked form.
Low findings pass with one short line on stderr. The default lets email addresses, license plates, gamer tags and share
links through. Send the same blocked prompt again within two minutes to send it anyway.

Clotr Guard supports Claude Code, Cursor, Gemini CLI, Codex CLI and Windsurf. It works with Node.js 20 or newer
and does not use the network.

## Stable and preview

Stable features have tests that run on every change and keep working the way this page describes. Preview features
are tested as well, but they may still change, and the reasons are under the table.

| Feature | Status | Tests |
| --- | --- | --- |
| Prompt check in Claude Code, Cursor, Gemini CLI, Codex CLI and Windsurf | Stable | [guard.test.js][guard-tests] |
| Sending a stopped prompt again within two minutes | Stable | [guard.test.js][guard-tests] |
| File-read check in Claude Code, Cursor, Gemini CLI and Windsurf | Stable | [guard.test.js][guard-tests] |
| Secret files turned away by each file-read check | Stable | [guard.test.js][guard-tests] |
| MCP tool-call check in Claude Code and Cursor | Stable | [guard.test.js][guard-tests] |
| Shell command check in Claude Code and Cursor | Preview | [guard.test.js][guard-tests] |
| `setup` and `remove`, with `--project` and `--dry-run` | Stable | [guard.test.js][guard-tests] |
| `check`, `commit-check` and the Git pre-commit hook | Stable | [guard.test.js][guard-tests] |
| `clotr-mcp` and its three tools | Preview | [mcp.test.js][mcp-tests] |
| The assistant skill | Preview | [guard.test.js][guard-tests] |
| No network calls | Stable | [rules.test.js][rules-tests] |

The shell check is a preview because it knows the usual ways to print a file or the environment, and a command it
doesn't know can still print one. `clotr-mcp` runs only when the assistant decides to call it, and its tools may change as assistants use them. The
skill is new, and each assistant looks for skills in its own folder.

[guard-tests]: https://github.com/clotr-app/clotr/blob/main/tests/guard.test.js
[mcp-tests]: https://github.com/clotr-app/clotr/blob/main/tests/mcp.test.js
[rules-tests]: https://github.com/clotr-app/clotr/blob/main/tests/rules.test.js

## Install

Install it globally:

```text
npm install -g clotr-guard
```

Hook setup and `clotr-mcp --print-config` stop in an npx cache and tell you to install Guard globally first.

## Install from a clone

From the repository root, build the engine bundle first with
`node tools/engine-bundle.js --out apps/guard/dist/clotr-engine.js`, then run `npm link ./apps/guard` to add the
`clotr-guard` and `clotr-mcp` commands to your PATH. You can also run `node apps/guard/bin/clotr-guard.js` instead. The
bundle is built from the checked-in engine files but isn't checked in itself, so until it's built every check answers
that Clotr couldn't check the text. Build it again after the engine changes, since `npm test` fails on a stale copy.

## Add Clotr MCP to an assistant

The `clotr-mcp` command ships in the Guard package and uses its engine and secret-file rules. After installing Guard,
print the configuration snippet for the assistant you use:

```text
clotr-mcp --print-config claude
clotr-mcp --print-config cursor
clotr-mcp --print-config gemini
clotr-mcp --print-config codex
clotr-mcp --print-config windsurf
clotr-mcp --print-config vscode
```

Add the snippet to Claude Code's `.mcp.json` or its MCP settings, Cursor's project or user MCP settings, Gemini CLI's
`~/.gemini/settings.json` or project `.gemini/settings.json`, Windsurf's MCP settings, VS Code's `.vscode/mcp.json` under
`servers`, or Codex CLI's `~/.codex/config.toml` under
`[mcp_servers.clotr]`. [Gemini CLI's MCP guide](https://geminicli.com/docs/tools/mcp-server/) describes its
`mcpServers` settings.

The server runs on this computer over standard input and output. It checks only when the assistant calls it and
returns finding kinds and masked forms. `include_personal_details` adds personal details to `check_text` and
`clean_text`; credentials stay checked either way.

## Give your assistant the Clotr skill

The package carries a skill file for coding assistants,
[`skills/clotr/SKILL.md`](https://github.com/clotr-app/clotr/blob/main/apps/guard/skills/clotr/SKILL.md). It tells
the assistant that when Clotr stops something, it should tell you what was stopped and leave the choice to you instead
of trying another way to get the same text. It also says how to call the MCP tools. Copy the `skills/clotr` folder to
`~/.claude/skills/clotr` for Claude Code, or to `~/.agents/skills/clotr` for Codex CLI, Gemini CLI and Cursor. The
installed copy sits in `clotr-guard/skills/clotr` under the folder that `npm root -g` prints.

## Set up a hook

Run one command for each assistant you use:

```text
clotr-guard setup claude
clotr-guard setup cursor
clotr-guard setup gemini
clotr-guard setup codex
clotr-guard setup windsurf
clotr-guard setup git
```

These commands add the prompt hook and, where supported, the file-read hook to your user settings. Run the command
inside a project with `--project` to add them to that project's settings instead. Use `--dry-run` to preview the
change. Run `clotr-guard remove <tool>` to remove Clotr's hooks, or add `--project` to remove its project hooks.
Before a change is written, Clotr saves a copy of an existing settings file beside it with `.clotr-guard.bak` on the
end, and a `.bak` of your own is left alone. `setup git` installs a local pre-commit hook in the current repository;
`remove git` removes it or restores the hook that was there before.

Claude Code uses `~/.claude/settings.json` and its `UserPromptSubmit` hook. Cursor uses `~/.cursor/hooks.json` and
`beforeSubmitPrompt`. Gemini CLI uses `~/.gemini/settings.json` and `BeforeAgent`. Codex CLI uses
`~/.codex/hooks.json` and `UserPromptSubmit`. Windsurf uses `~/.codeium/windsurf/hooks.json`, `pre_user_prompt` and
`pre_read_code`; project setup uses `.windsurf/hooks.json`. Other project settings files are `.claude/settings.json`,
`.cursor/hooks.json`, `.gemini/settings.json` and `.codex/hooks.json` in the current directory.

Prompt, file-read and commit checks leave personal details out by default while credentials stay checked. Add
`--personal-details` to Guard hook setup or `commit-check` to include them. An internal network address or host name
counts as a personal detail here. With the option on, Guard names it in a short line but lets the prompt, read or
commit through, since telling an assistant about your own server is ordinary work.

The prompt hook checks only the prompt field each tool sends to it. Claude Code also checks `mcp__` tool arguments and
Cursor checks MCP arguments and shell commands. Those checks stop credentials and medium or high findings, asking you
to decide where the tool supports a question. The Bash and shell hooks look for credentials in commands, common
environment dumps and file readers that could print secret files. They use the same secret-file rules as reads and
commits. They do not scan ordinary command words. File-read hooks check Claude Code's `Read`, Cursor's Agent file
reads, Gemini CLI's `read_file` and Windsurf's `pre_read_code`. Binary files and folders pass without a message. Text saved as
UTF-16, with or without a byte order mark, or in an older single-byte code page is checked like any other text. A
larger text read checks the first 256 KiB and says the rest wasn't checked. The read hooks show only finding kinds and masked forms. Secret
files are denied in every tool with a reason for the assistant
and no prompt to you. In Claude Code, ordinary files with credentials ask whether to allow the read. The other tools
stop it, because a second read would come from the assistant rather than from you, so reading the same file again
never lets it through. Claude Code also
gets a `Bash` hook for plain commands that print secret files or dump the environment. Gemini CLI also loads `.env` files by default. After
`setup gemini`, Clotr prints how to turn this off with `advanced.ignoreLocalEnv` in Gemini's `settings.json`; Clotr
does not change that setting. Hook findings never include the full value in their
message. On Windows, Clotr keeps its repeat record in `%LOCALAPPDATA%\Clotr\guard`; other systems use their per-user
application data folder. Records hold a random salt, a salted prompt hash and the time of the first warning.
Clotr does not save prompt text or file contents. A check error lets the action through with a visible message that says
it went through unchecked. Claude Code, Gemini CLI and Codex CLI give each check up to 15 seconds.

Use `--min-severity low`, `medium` or `high` with `check`, `setup`, `hook` or `read` to change the stop threshold. The
default is `medium`.

## Check text yourself

Pass a file or pipe text through standard input:

```text
clotr-guard check prompt.txt
type prompt.txt | clotr-guard check --json
```

The command prints one masked finding per line and returns 1 if it found something at or above the minimum severity.
`--json` prints the safe result object, including its decision and masked findings.
Files above 1 MiB return the same short error used when Clotr cannot check text.

## Check staged Git changes

Run `clotr-guard commit-check` to check staged changes before committing. It checks added lines in the staged diff,
plus staged secret-file names. A staged secret file stops the commit even when Git ignores it, since a forced add is
how it got there; take it out of the commit instead. Credential findings print a quoted file name, line, kind and
masked value. Git treats a file saved as UTF-16 as binary, so Clotr reads that file from the staging area and checks
the lines the last commit didn't have. Personal details do not stop a commit unless you add `--personal-details`. The
working copy is not scanned. `git commit --no-verify` skips Git hooks, as Git allows.

Guard reads each staged diff separately. If one is larger than 16 MiB, it checks the first 256 KiB of added text,
names the file, says the rest wasn't checked and stops the commit. If that file belongs in the repository, add its path to `.clotrignore`. If a file's diff can't be read, Guard names that
file and stops the commit after checking the other staged files. Only a check that can't run at all, such as one
outside a Git repository or with Git or Guard missing, lets the commit through with a line saying it wasn't checked.

`clotr-guard setup git` installs a local `pre-commit` hook. If the repository already has one, Clotr saves it beside
the hook and calls it after the staged check passes. That hook still runs when Node.js can't be found, with a line
saying Clotr's check was skipped. Use `clotr-guard remove git` to restore that hook. A hook Clotr didn't write, such
as one you wrote around `clotr-guard commit-check`, stays as it is. If an older backup is still beside the hook, setup
stops and asks you to move it first. Repositories with a custom `core.hooksPath` are left unchanged. Running setup
again points the hook at the Guard you ran it from. If the hook's Guard has been removed, commits go through with a
line asking you to set the check up again, and the same goes for a check that fails to run.

For the pre-commit framework, add this entry to `.pre-commit-hooks.yaml`:

```yaml
- id: clotr-guard
  name: Check staged changes with Clotr Guard
  entry: clotr-guard commit-check
  language: system
  pass_filenames: false
  always_run: true
```

## `.clotrignore`

Clotr Guard reads a `.clotrignore` at the repository root for every hook and the pre-commit check.

Path lines use gitignore syntax (globs, `**`, `!` negation, comments, trailing `/` for folders). A matching file is
skipped silently. Value lines never hold a raw value, because the file gets committed and someone will paste a real
key into it to silence a warning. Instead `clotr-guard ignore-value` reads a value from stdin (never an argument, so
it stays out of shell history), and appends `fingerprint: <salted SHA-256>` with a per-repository salt kept in
`.clotrignore` itself as `salt: <random>`. Anyone who can read the repository can read that salt too and try every
likely value against a fingerprint, so the command turns down a value that's easy to guess that way, like an email
address, a phone or card number, a password or anything short. A path line is the way to quiet those. Raw values in
the file (`value: ...`) are refused with one short message saying to use the command.

Secret files (the shared secret-file list, `.env` and friends) stay protected even if `.clotrignore` names them:
`.clotrignore` quiets findings, it never lets an assistant read a secret file.
