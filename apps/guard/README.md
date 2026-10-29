# Clotr Guard

Clotr Guard checks prompts and file reads through hooks for supported AI coding assistants. You can also check a text
file yourself or set up the Git pre-commit check. It uses the same on-device engine as Clotr's other apps. A clean
prompt passes. Medium and high findings pause that prompt and show their kind and masked form. Low findings pass with
one short line on stderr. The default lets email addresses, license plates, gamer tags and share links through. Send
the same prompt again within two minutes to send it anyway. A new finding pauses it again.

Clotr Guard supports Claude Code, Cursor, Gemini CLI, Codex CLI, Windsurf Cascade and Cline hooks on macOS and Linux.
Its checks run on your computer. Clotr Guard makes no network calls or sends text to a Clotr server. A prompt that the
assistant is allowed to send still goes to that assistant's AI service as usual. Guard needs Node.js 20 or newer.

## Runs locally

Guard, including its `clotr-mcp` server, runs on your machine as a child process of your AI client and talks to it
over stdio (standard input and output). It opens no network connection and never stores the text it scans. So you
can resend a paused prompt, the prompt hooks keep a salted fingerprint of what they found for two minutes, never the
text itself. MCP calls the
side that offers tools a "server" because that's the name of its role in the protocol, not because it's a remote
machine.

## Stable and preview

Stable features have tests that run on every change and keep working the way this page describes. Preview features
are tested as well, but they may still change, and the reasons are under the table.

| Feature | Status | Tests |
| --- | --- | --- |
| Prompt check in Claude Code, Cursor, Gemini CLI, Codex CLI, Windsurf Cascade and Cline | Stable | [guard.test.js][guard-tests] |
| Sending a stopped prompt again within two minutes | Stable | [guard.test.js][guard-tests] |
| File-read check in Claude Code, Cursor, Gemini CLI, Windsurf Cascade and Cline | Stable | [guard.test.js][guard-tests] |
| Secret files turned away by each file-read check | Stable | [guard.test.js][guard-tests] |
| MCP tool-call check in Claude Code and Cursor | Stable | [guard.test.js][guard-tests] |
| Shell command check in Claude Code and Cursor | Preview | [guard.test.js][guard-tests] |
| `setup` and `remove`, with `--project` and `--dry-run` | Stable | [guard.test.js][guard-tests] |
| Cline hooks on macOS and Linux | Stable | [guard.test.js][guard-tests] |
| `check`, `commit-check` and the Git pre-commit hook | Stable | [guard.test.js][guard-tests] |
| `clotr-mcp` (or `clotr-guard mcp`) and its three tools | Preview | [mcp.test.js][mcp-tests] |
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

Hook setup and `clotr-mcp --print-config` stop when run through npx, and tell you to install Guard globally first.
The MCP server is the one part that runs straight from npx, as `npx -y clotr-guard mcp`.

## Install from a clone

From the repository root, build the engine bundle first with
`node tools/engine-bundle.js --out apps/guard/dist/clotr-engine.js`, then run `npm link ./apps/guard` to add the
`clotr-guard` and `clotr-mcp` commands to your PATH. You can also run `node apps/guard/bin/clotr-guard.js` instead. The
bundle is built from the checked-in engine files but isn't checked in itself, so until it's built every check answers
that Clotr couldn't check the text. Build it again after the engine changes, since `npm test` fails on a stale copy.

## Add Clotr MCP to an assistant

The MCP server ships in the Guard package and uses its engine and secret-file rules. It starts with `clotr-mcp` or
`clotr-guard mcp`, which run the same server. After installing Guard, print the configuration snippet for the
assistant you use:

```text
clotr-mcp --print-config claude
clotr-mcp --print-config cursor
clotr-mcp --print-config gemini
clotr-mcp --print-config codex
clotr-mcp --print-config windsurf
clotr-mcp --print-config cline
clotr-mcp --print-config vscode
```

Add the snippet to Claude Code's `.mcp.json` or its MCP settings, Cursor's project or user MCP settings, Gemini CLI's
`~/.gemini/settings.json` or project `.gemini/settings.json`, Windsurf's MCP settings, Cline's MCP Servers settings
or `~/.cline/data/settings/cline_mcp_settings.json` for the CLI, VS Code's `.vscode/mcp.json` under `servers`, or
Codex CLI's `~/.codex/config.toml` under `[mcp_servers.clotr]`.
[Gemini CLI's MCP guide](https://geminicli.com/docs/tools/mcp-server/) describes its `mcpServers` settings.

To skip the global install, point the assistant at npx instead, and npm downloads Guard into its cache the first time
the server starts:

```json
{
  "mcpServers": {
    "clotr": { "command": "npx", "args": ["-y", "clotr-guard", "mcp"] }
  }
}
```

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
clotr-guard setup cline
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
`~/.codex/hooks.json` and `UserPromptSubmit`. Windsurf Cascade uses `~/.codeium/windsurf/hooks.json`, `pre_user_prompt`
and `pre_read_code`; project setup uses `.devin/hooks.json`, or the existing `.windsurf/hooks.json` when it is the
active legacy file. Cline uses extensionless executable hooks in `~/Documents/Cline/Hooks/` and its `UserPromptSubmit`
and `PreToolUse` events; project setup uses `.clinerules/hooks/`. In Cline, turn on **Enable Hooks** in Feature
Settings. [Cline's hook guide](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md) lists its supported
events and platforms. Cline hooks are supported on macOS and Linux only. Other project settings files are `.claude/settings.json`,
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
reads, Gemini CLI's `read_file`, Windsurf Cascade's `pre_read_code` and Cline's `PreToolUse`. Binary files and folders pass without a message. Text saved as
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
application data folder. The record is local plain state readable by the same computer account or its processes, and
Guard does not sync it. It holds a random salt, salted fingerprints of the findings and the time of the first warning.
Clotr does not save prompt text or file contents. If Clotr hits an internal error while checking readable input, Guard
lets the action through with a visible note that says it went through unchecked. Guard stops input it can't read,
including malformed hook input and text over the size limit. Claude Code, Gemini CLI and Codex CLI give each check up to
15 seconds.

### Search results

The read hook also checks searches that return matching lines: Claude Code's `Grep` only in `output_mode: "content"`,
Gemini CLI's `search_file_content` and `grep_search`, Cline's `search_files`, and Gemini's `read_many_files`. Claude's
`files_with_matches` and `count` modes return paths or counts and pass. Guard checks the search path and include glob,
then walks up to 2,048 entries or 250 ms total, skipping `.git` and `node_modules`. Ripgrep and Git reachability probes
share that same time limit. If a limit is reached, the search passes and Guard writes a note to stderr.

Guard follows the tools' filters when deciding whether a found file can be returned:

- Claude Code's Grep runs ripgrep with hidden paths enabled; ripgrep's ignore rules still apply. [Ripgrep's FAQ](https://ripgrep.dev/docs/faq/)
  describes its ignore-file behavior.
- Cline's `search_files` invokes ripgrep without `--hidden`, so hidden paths such as `.env` are skipped, along with
  ripgrep's normal ignored paths. If ripgrep is unavailable, Cline's fallback uses an extension allowlist and skips
  extensionless dotfiles. See [Cline's search executor](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/executors/search.ts).
- Gemini's content search tries `git grep --untracked` first, which skips Git-ignored untracked files but can search
  tracked files; its system `grep` fallback can include hidden and ignored files. `names_only` returns paths only, and
  `exclude_pattern` filters matching lines, not filenames. See [Gemini's grep tool](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/grep.ts).
- Gemini's `read_many_files` uses glob patterns and includes dotfiles. Its default exclusions include `.env`, common
  development directories and binary formats. It respects `.gitignore` and `.geminiignore` by default; `useDefaultExcludes: false`
  or disabling ignore filtering can make a file reachable. See [Gemini's multi-file reader](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/read-many-files.ts)
  and [its default exclusions](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/ignorePatterns.ts).

When Guard stops a content search, its message names the secret file and gives an example file glob that leaves it out.

Use `--min-severity low`, `medium` or `high` with `check`, `setup`, `hook` or `read` to change the stop threshold. The
default is `medium`.

## Check text yourself

Pass a file or pipe text through standard input:

```text
clotr-guard check prompt.txt
type prompt.txt | clotr-guard check --json
```

The command prints one masked finding per line and returns 1 if it found something at or above the minimum severity.
`--json` prints the result object, including its decision and masked findings. When nothing is found, the command
prints "Nothing found." in a terminal and nothing at all when its output goes to another program.
Files above 1 MiB return the same short error used when Clotr cannot check text.

## Check staged Git changes

Run `clotr-guard commit-check` to check staged changes before committing. It checks added lines in the staged diff,
plus staged secret-file names. A staged secret file stops the commit even when Git ignores it, since a forced add is
how it got there; take it out of the commit instead. Credential findings print a quoted file name, line, kind and
masked value. Git treats a file saved as UTF-16 as binary, so Clotr reads that file from the staging area and checks
the lines the last commit didn't have. Personal details do not stop a commit unless you add `--personal-details`. The
working copy is not scanned. `git commit --no-verify` skips Git hooks, as Git allows.

Guard reads each staged diff separately. If one is larger than 16 MiB, it checks the first 256 KiB of added text,
names the file, says the rest wasn't checked and stops the commit. Split the change or keep large generated files out
of the repository. If a file's diff can't be read, Guard names that
file and stops the commit after checking the other staged files. Only a check that can't run at all, such as one
outside a Git repository or with Git or Guard missing, lets the commit through with a line saying it wasn't checked.

`clotr-guard setup git` installs a local `pre-commit` hook. If the repository already has one, Clotr saves it beside
the hook and calls it after the staged check passes. That hook still runs when Node.js can't be found, with a line
saying Clotr's check was skipped. Use `clotr-guard remove git` to restore that hook. A hook Clotr didn't write, such
as one you wrote around `clotr-guard commit-check`, stays as it is. If an older backup is still beside the hook, setup
stops and asks you to move it first. Repositories with a custom `core.hooksPath` are left unchanged. Running setup
again points the hook at the Guard you ran it from. If the hook's Guard has been removed, commits go through with a
line asking you to set the check up again, and the same goes for a check that fails to run.

For the pre-commit framework, add this to your `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: clotr-guard
        name: Check staged changes with Clotr Guard
        entry: clotr-guard commit-check
        language: system
        pass_filenames: false
        always_run: true
```

It runs the `clotr-guard` you installed globally.

## `.clotrignore`

Clotr Guard reads a `.clotrignore` at the repository root for every hook and the pre-commit check.

Only exact value fingerprints in `.clotrignore` suppress Guard findings. Path patterns are ignored and cannot turn
checks off for a file. Value lines never hold a raw value, because the file gets committed and someone will paste a
real key into it to silence a warning. Instead `clotr-guard ignore-value [--kind <kind>]` reads a value from stdin (never an argument,
so it stays out of shell history), and appends `fingerprint: <salted SHA-256>` with a per-repository salt kept in
`.clotrignore` itself as `salt: <random>`. Anyone who can read the repository can read that salt too and try every
likely value against a fingerprint, so the command refuses passwords, personal details and values with too little
length or character variation. When a caller knows the finding kind, it can pass `--kind <kind>`; the value still
comes from stdin. Refused values should be removed from the source or ignored once in the editor. Raw values in the
file (`value: ...`) are refused with one short message saying to use the command.

Secret files (the shared secret-file list, `.env` and friends) stay protected by Guard's separate secret-file rules.
