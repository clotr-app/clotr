# Guard's code

`bin/clotr-guard.js` reads the command line and picks what to run, and `bin/clotr-mcp.js` starts the MCP server. Both
paths stay put, because hooks and MCP settings on people's computers point at them. Everything they run is in here.
This file is for the repo and isn't in the npm package.

## Folders

| Folder | What it does | Files |
| --- | --- | --- |
| `lib/` | What more than one folder uses, and what other products read | `limits-and-messages.js`, `check-budget.js`, `clotrignore.js`, `secret-files.js`, `git-repository.js`, `safe-file-writes.js` |
| `text-checks/` | Runs the engine on a text | `engine-loader.js`, `check-text.js`, `text-decode.js` |
| `commands/` | What each `clotr-guard` command does | `check-command.js`, `commit-check.js`, `ignore-value-command.js`, `piped-input.js`, `command-help.js` |
| `setup/` | Puts Guard's hooks into each assistant's settings and takes them out | `assistant-settings-paths.js`, `assistant-settings.js`, `cline-hooks.js`, `git-hook-setup.js`, `hook-command-writer.js`, `hook-command-reader.js`, `installed-hooks.js` |
| `shell-reading/` | Reads a command line the way each shell would | `command-line-parser.js`, `shell-quoting.js`, `empty-variable-spellings.js`, `file-reading-commands.js`, `nested-commands.js`, `copy-commands.js`, `recursive-read-targets.js`, `search-pattern-words.js`, `commit-message-words.js` |
| `path-forms/` | The many ways one path can be written | `windows-paths.js`, `path-readings.js`, `glob-matching.js`, `glob-expansion.js`, `drive-top-folders.js`, `network-mounts.js` |
| `secret-paths/` | Decides whether a path is a secret file, however it's written | `secret-path-check.js`, `secret-name-matching.js` |
| `search-checks/` | Checks a search that could print secret files | `search-check.js`, `search-filters.js`, `ripgrep-and-git-listing.js` |
| `shell-checks/` | Decides whether a shell command opens a secret file | `shell-check.js` (the way in), `command-line-readings.js`, `secret-in-command.js`, `opened-file-check.js`, `recursive-read-check.js`, `folder-changes-and-variables.js`, `xargs-find-and-copies.js`, `environment-dumps.js` |
| `hooks/` | An assistant's hook, from its event to Guard's answer | `hook-output.js`, `file-read-check.js`, `file-read-tools.js`, `shell-check-process.js` |
| `mcp-server/` | The MCP server | `mcp-tools.js`, `mcp-requests.js`, `mcp-line-reader.js` |

`clotrignore.js` and `secret-files.js` stay at the top because the VS Code and JetBrains plugins read them by that path.
`engine.js` is a leftover that loads `text-checks/engine-loader.js`, because the released VS Code build still packs
Guard's engine from the old path. Guard's next release removes it.
VS Code's build copies the lib files but leaves out `mcp-server/`, since the extension never runs the server.

## Testing it

From the repo root, `node --test tests/guard*.test.js tests/mcp.test.js` runs Guard's tests.
`tests/guard-require-cycles.test.js` fails if two files ever need each other while they load, and `tests/guard.test.js`
checks that every file in here is on `package.json`'s `files` list, so it ships.
