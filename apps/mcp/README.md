# Clotr MCP

Clotr MCP is a local server an AI tool can call to check or clean text. It runs only when the tool calls it, so it's
not an automatic send guard. The text is already in that tool, so Clotr MCP cannot keep it from the tool's own AI service.
It returns kinds and masked forms, and makes no network requests or saved copy of the text.

## Runs locally

Clotr MCP runs on your machine as a child process of your AI client, started over stdio (standard input and output).
It opens no network connection, and it stores nothing it scans. "Server" is MCP's name for a role, the side that
offers tools, not a remote machine.

The `clotr-mcp` command ships with Clotr Guard and uses Guard's engine and secret-file rules. It implements MCP
2026-07-28 and accepts the older `initialize` handshake for existing clients.

## Tools

`check_text` checks text and returns finding kinds, masked forms, and a one-line verdict. Personal details are left out
unless the caller sets `include_personal_details` to `true`.

`clean_text` returns the text with each finding replaced by the engine's placeholder, plus the finding kinds and masked
forms. Credentials stay checked, while personal details are left out unless `include_personal_details` is `true`. The
text is capped at 64 KiB per call.

The MCP server does not read `.clotrignore` and has no ignore option. Each submitted text is checked as sent. It keeps
no salt or finding state.

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
| Cline | MCP Servers settings, or `~/.cline/data/settings/cline_mcp_settings.json` for the CLI |
| VS Code | `.vscode/mcp.json`, under `servers` |
| Codex CLI | `~/.codex/config.toml` or `.codex/config.toml`, under `[mcp_servers.clotr]` |

The snippets use each host's documented local stdio format. The MCP specification was version `2026-07-28`, dated
28 July 2026. Platform configuration docs were checked on 25 October 2026:

- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Windsurf Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp)
- [Cline MCP](https://docs.cline.bot/mcp/mcp-overview)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Codex MCP](https://developers.openai.com/codex/mcp)

## Limits

Text over 64 KiB is refused before the engine checks it. Findings contain only a kind and masked form. Cleaned text
contains the original text around each replaced finding, so review the cleaned copy before sending it.
