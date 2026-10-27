# Clotr Guard plugin for Claude Code

This plugin adds Clotr Guard's prompt check to Claude Code. Each prompt is checked on your device before it's sent,
and one holding a credential is stopped with its kind and a masked form. Send it again within two minutes with the
same findings to send it anyway. A new finding pauses it again.

It runs Guard through npx, so it needs Node.js 20 or newer and no global install. The hook names the Guard version it
was built with, and npm downloads that version into its cache the first time. That first download can take longer
than the hook's 15 seconds, and a check that runs out of time lets the prompt through, so warm the cache once:

```text
npx -y clotr-guard@0.1.1 --version
```

To try it from a clone, start Claude Code with `claude --plugin-dir apps/guard/plugin`.

The plugin has the prompt check only. `clotr-guard setup claude` adds the file-read, Bash and MCP tool-call checks as
well, so use one or the other, since both together check each prompt twice. The full Guard docs are in
[apps/guard](https://github.com/clotr-app/clotr/tree/main/apps/guard#readme).
