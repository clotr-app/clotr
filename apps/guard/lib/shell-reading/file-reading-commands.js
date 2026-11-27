"use strict";
/* global module */

// ---------- Commands that read files ----------

// The commands that read the files they're given, as the shell check knows them.
const SHELL_READER_NAMES = [
  "cat|type|Get-Content|less|more|head|tail|grep|sed|awk|base64|xxd|strings|gc|cp|copy|source|tac|nl|od",
  "hexdump|rev|paste|fold|cut|sort|uniq|diff|bat|Select-String|sls|findstr|rg",
].join("|");
const SHELL_READER_NAME = new RegExp(`^(?:${SHELL_READER_NAMES})$`, "i");
// A blank that isn't a line break.
const LINE_BLANK = "[^\\S\\r\\n\\u2028\\u2029]";
// Words before a reader that run it: `sudo cat`, `cmd /c type`.
const READER_LEAD = `(?:sudo|command|exec|nohup|time|env|cmd(?:\\.exe)?${LINE_BLANK}+\\/c)`;
// A reader's name found anywhere a command could start, even inside quotes, where it may be the text of a
// nested shell such as `ssh host "x; cat .env"`; see secretInParsedShell for how its arguments are read. The
// match ends at the name, so the next search starts there and finds a reader inside this one's words too.
const SHELL_READER_AT = new RegExp(
  `(?:^|[;&|(\`])${LINE_BLANK}*(?:${READER_LEAD}${LINE_BLANK}+"?)*(${SHELL_READER_NAMES})\\b`,
  "gim",
);
// Where Guard's first shell check ended a reader's words: at any of these, quoted or not.
const SHELL_OLD_STOPS = ";&|)`";
// ---------- Shells inside shells ----------

// cmd's `type` and `copy` glued to what they're given: `type.env`, `copy/b a b`.
const CMD_GLUED_READER = /^(type|copy)([^A-Za-z0-9].*)$/i;

module.exports = {
  SHELL_READER_NAMES,
  SHELL_READER_NAME,
  SHELL_READER_AT,
  SHELL_OLD_STOPS,
  CMD_GLUED_READER,
};
