# Clotr MCP

Clotr MCP lets a local AI tool check text before sending it outside the computer, posting it, or writing it to another
tool. The server runs on the computer over standard input and output. It makes no network requests and does not log or
save the text.

The text an AI tool asks it to check is already in that tool, so Clotr MCP can't keep it from the tool's own AI service.
It helps the tool avoid passing the text on, and it answers with kinds and masked forms only.

The `clotr-mcp` command ships inside the Clotr Guard package, so it uses Guard's engine and secret-file rules at the
same version. The server implements MCP 2026-07-28 and also accepts the older `initialize` handshake used by existing
clients. The tools run only when the host calls them, so this is a check an assistant can choose to use, not an automatic
send guard.

## Tools

`check_text` checks text and returns finding kinds, masked forms, and a one-line verdict. Personal details are left out
unless the caller sets `include_personal_details` to `true`.

`clean_text` returns the text with each finding replaced by the engine's placeholder, plus the finding kinds and masked
forms. Credentials stay checked, while personal details are left out unless `include_personal_details` is `true`. The
text is capped at 64 KiB per call.

The MCP server reads the repository's `.clotrignore` file. The MCP tool accepts an `ignoreFingerprints` option and
compares those fingerprints with values in checked text using the file's salt.

`is_secret_file` checks a path with Guard's secret-file rules. It does not read the file.

## Run it

Install Guard globally with `npm install -g clotr-guard`, then run `clotr-mcp`. The process communicates through
stdin and stdout. There is no network transport. The tool does not change any host
settings.

From a source checkout, run `node apps/mcp/bin/clotr-mcp.js` from the repository root.

Print a host-specific configuration snippet with:

```text
node apps/mcp/bin/clotr-mcp.js --print-config claude
node apps/mcp/bin/clotr-mcp.js --print-config cursor
node apps/mcp/bin/clotr-mcp.js --print-config gemini
node apps/mcp/bin/clotr-mcp.js --print-config windsurf
node apps/mcp/bin/clotr-mcp.js --print-config cline
node apps/mcp/bin/clotr-mcp.js --print-config vscode
node apps/mcp/bin/clotr-mcp.js --print-config codex
```

Run `clotr-mcp --print-config <assistant>` after installation to print a snippet that points to the installed package.
Add it to the matching host file. The command only prints a snippet; it never writes settings.

| Tool | Where its MCP configuration goes |
| --- | --- |
| Claude Code | `.mcp.json` or the settings file managed by `claude mcp` |
| Cursor | `mcp.json` in the project or Cursor settings |
| Gemini CLI | `~/.gemini/settings.json` or `.gemini/settings.json` in the project |
| Windsurf Cascade | MCP settings, including `%APPDATA%\devin\mcp_config.json` on Windows |
| Cline | MCP Servers settings or its MCP configuration file |
| VS Code | `.vscode/mcp.json`, under `servers` |
| Codex CLI | `~/.codex/config.toml` or `.codex/config.toml`, under `[mcp_servers.clotr]` |

The snippets use each host's documented local stdio format. The MCP specification was version `2026-07-28`, dated
28 July 2026. Platform configuration docs were checked on 18 October 2026:

- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Windsurf Cascade MCP](https://docs.windsurf.com/windsurf/cascade/mcp)
- [Cline MCP](https://docs.cline.bot/mcp/configuring-mcp-servers)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Codex MCP](https://developers.openai.com/codex/mcp)

## Limits

Text over 64 KiB is refused before the engine checks it. Findings contain only a kind and masked form. Cleaned text
contains the original text around each replaced finding, so review the cleaned copy before sending it.
