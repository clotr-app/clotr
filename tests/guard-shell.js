// A shell check run three ways: Claude's Bash tool, its PowerShell tool, and Cursor, whose terminal could be either.
// `shellReading` "new" or "first" runs only the shell's own reading of the command or only Guard's first one.
"use strict";

const guard = require("../apps/guard/bin/clotr-guard.js");

function quotedSeparatorShell(root, shellReading) {
  return (command, toolName) =>
    toolName === "Cursor"
      ? guard.inspectShell("cursor", { command, cwd: root }, { cwd: root, shellReading })
      : guard.inspectShell(
          "claude",
          { tool_name: toolName, tool_input: { command, cwd: root } },
          { cwd: root, shellReading },
        );
}

// Commands that read .env after a long run of blank space, as [label, commandOf(size), toolName, size]: wrapper words
// (`time`, `sudo`) split across lines, each a new place a reader could start, then blank space inside one quoted
// operand, which each path check reads.
function blankSpaceCommands() {
  const before = (blank) => (size) => `echo start;${blank.repeat(Math.ceil(size / blank.length))}; cat .env`;
  return [
    ...[
      [" ", 150_000],
      ["\n", 150_000],
      ["\t ", 150_000],
      ["time\n", 300_000],
      ["sudo \n", 300_000],
      ["cmd /c\n", 300_000],
    ].map(([blank, size]) => [`blank ${JSON.stringify(blank)}`, before(blank), "Bash", size]),
    ["Bash quoted lines", (size) => `cat "a${"\n".repeat(size)}b" .env`, "Bash", 300_000],
    ["Bash quoted spaces", (size) => `cat 'a${" ".repeat(size)}' .env`, "Bash", 300_000],
    ["Bash quoted tabs", (size) => `grep SAMPLE "a${"\t".repeat(size)}b" .env`, "Bash", 300_000],
    [
      "PowerShell quoted lines",
      (size) => `Get-Content -LiteralPath "a${"\n".repeat(size)}b"; Get-Content .env`,
      "PowerShell",
      300_000,
    ],
  ];
}

// Commands with an operand holding a long run of dots, spaces or colons, then .env, as [label, commandOf(size),
// toolName]. Each part of a path loses its stream and its last dots and spaces, as Windows reads it; a run with more
// after it is the slow shape for a pattern anchored at the part's end.
function dottedOperandCommands() {
  const operand = (build) => (size) => build((text) => text.repeat(Math.ceil(size / text.length)));
  const operands = [
    (run) => `"a${run(" ")}b"`,
    (run) => `"a${run(".")}b"`,
    (run) => `"a${run(". ")}b"`,
    (run) => `"${run(" ")}b"`,
    (run) => `"${run(".")}b"`,
    (run) => `"a${run(" ")}b/c"`,
    (run) => `"a${run(":")}\nb"`,
    (run) => `'//?/C:/a${run(".")}x'`,
    (run) => `'//./C:/a${run(" ")}x/y'`,
    (run) => `'//fileserver.example/share/a${run(".")}x'`,
  ];
  const label = (commandOf, toolName) => `${toolName} ${JSON.stringify(commandOf(24).slice(0, 24))}…`;
  const commands = [
    ...operands.map((build) => [(size) => `cat ${operand(build)(size)} .env`, "Bash"]),
    [(size) => `Get-Content -LiteralPath "a${" ".repeat(size)}b"; Get-Content .env`, "PowerShell"],
    [(size) => `Get-Content -LiteralPath "a${".".repeat(size)}b"; Get-Content .env`, "PowerShell"],
  ];
  return commands.map(([commandOf, toolName]) => [label(commandOf, toolName), commandOf, toolName]);
}

// Commands with a long run of quoted text, of readers inside quotes or a here-document, or of nesting, as [label,
// commandOf(size), toolName, action, counts]. The action is the answer at the sizes the tests use: "stop" is a block
// for any file, not only .env. `counts` names the work counts to check, all of them when it's missing.
function quotedRunCommands() {
  // With many readers inside one quoted run, the check takes the command up to each reader as a slice that shares
  // the command's memory and reads only from the reader on. The meter counts a slice's whole length, so for those
  // commands it checks the steps and the regex runs only.
  const READERS_IN_QUOTES = ["steps", "execs"];
  const commands = [
    [(run) => `cat "${run("a|;&)")}" .env`, "Bash", "block"],
    [(run) => `cat '${run("a|;&)`")}' .env`, "Bash", "block"],
    [(run) => `cat $'${run("a|\\x2e")}' .env`, "Bash", "block"],
    [(run) => `cat ${run("a\\|")} .env`, "Bash", "block"],
    [(run) => `cat "${run("$(")}" .env`, "Bash", "block"],
    [(run) => `echo "${run("; cat '")}" ; cat .env`, "Bash", "block"],
    [(run) => `cat > notes.md <<EOF\n${run("More of it's here\n")}EOF\ncat .env`, "Bash", "block"],
    [(run) => `Get-Content "${run("a;|&)")}", .env`, "PowerShell", "block"],
    [(run) => `Get-Content '${run("a'';")}', .env`, "PowerShell", "block"],
    [(run) => `Get-Content ${run("a`;")} .env`, "PowerShell", "block"],
    [(run) => `Get-Content ${run("{")} .env`, "PowerShell", "block"],
    [(run) => `cat "${run("a|;&^")}" .env`, "Cursor", "block"],
    [(run) => `git commit -m "${run("fix: a|b; c&d ")}"`, "Bash", "allow"],
    [(run) => `grep -E '${run("a|b")}' src`, "Bash", "allow"],
    // Many readers inside quotes or a here-document, each read from its own name.
    [(run) => `git commit -m "${run("fix (cat a) ")}"`, "Bash", "allow"],
    [(run) => `git commit -m "${run("fix (gc a) ")}"`, "PowerShell", "allow"],
    [(run) => `cat <<EOF\n${run("cat a\n")}EOF\ncat .env`, "Bash", "block"],
    [(run) => `git commit -F - <<EOF\n${run("Type it's here\n")}EOF`, "Cursor", "allow", READERS_IN_QUOTES],
    [(run) => `echo "${run("$(cat a) ")}"`, "Bash", "allow"],
    [(run) => `echo '${run("(cat ")}'`, "Bash", "allow", READERS_IN_QUOTES],
    [(run) => `echo '${run(";cat $(")}'`, "Bash", "allow", READERS_IN_QUOTES],
    [(run) => `echo '${run(";cat <<EOF\n")}'`, "Bash", "allow", READERS_IN_QUOTES],
    [(run) => `echo '${run(";cat {")}'`, "PowerShell", "allow", READERS_IN_QUOTES],
    [(run) => `echo '${run(';gc @"\n')}'`, "PowerShell", "allow", READERS_IN_QUOTES],
    // Here-document and here-string bodies full of $(…), and many switches with a quoted value in Cursor.
    [(run) => `cat <<EOF\n${run("v=$(echo a) it's\n")}EOF`, "Bash", "allow"],
    [(run) => `cat <<EOF\n${run("$(")}\nEOF\ncat .env`, "Bash", "block"],
    [(run) => `@"\n${run("v=$(echo a)\n")}"@ | Out-File notes.txt`, "PowerShell", "allow"],
    [(run) => `grep ${run("--include='*.js' ")} '^x .*' src`, "Cursor", "allow"],
    // Lists over many lines, raw arguments after --%, groups, wrapper words and redirections before a command.
    [(run) => `gc a,${run(",\n")}.env`, "PowerShell", "block"],
    [(run) => `gc a${run(", #c\n")}.env`, "PowerShell", "block"],
    [(run) => `gc a${run(",<#c#>\n")}.env`, "PowerShell", "block"],
    [(run) => `findstr --% ${run("x #y ")}.env`, "PowerShell", "block"],
    [(run) => `findstr --% "${run("a|;#")}" .env`, "PowerShell", "block"],
    [(run) => `echo ${run("x --% y #")}`, "PowerShell", "allow"],
    [(run) => `gc ${run("('a',")} .env`, "PowerShell", "block"],
    [(run) => `gc ${run("('a') ")} .env`, "PowerShell", "block"],
    [(_run, size) => `gc ${"(".repeat(size / 3)}'a'${")".repeat(size / 3)}, .env`, "PowerShell", "block"],
    [(_run, size) => `Write-Output ${"@(".repeat(size / 3)}'a'${")".repeat(size / 3)}`, "PowerShell", "allow"],
    [(run) => `${run('"sudo" ')}cat .env`, "Bash", "block"],
    [(run) => `${run("2>/dev/null ")}cat .env`, "Bash", "block"],
    [(run) => `echo "${run("${x:-'$(echo a)'}")}"`, "Bash", "allow"],
    [(run) => `cmd /c"${run("type a ")}" .env`, "PowerShell", "block"],
    [(run) => `echo "${run("${x[a${x[")}"`, "Bash", "allow"],
    [(run) => `${run("<<< x ")}cat .env`, "Bash", "block"],
    [(run) => `cmd ${run("/d")}/c type .env`, "PowerShell", "block"],
    [(run) => `cp ${run("(a)")} (Join-Path x '.env')`, "PowerShell", "allow"],
    // Quotes inside "${x:-…}", a filter's -InputObject, cmd switches with values, and Bash's `"a"*` as Guard first read
    // it.
    [(run) => `echo "${run("${x:-'a'}")}"`, "Bash", "allow"],
    [(run) => `cat "\${x:-'${run("$(echo a)")}'}" .env`, "Bash", "block"],
    [(run) => `echo "\${x:-'${run("${y:-")}'}"; cat .env`, "Bash", "block"],
    [(run) => `cat "\${x:-'${run('}" ')}'}" .env`, "Cursor", "block"],
    [(run) => `gc (select ${run("-InputObject a ")}'.env')`, "PowerShell", "block"],
    [(run) => `gc (${run("('select', ")}'.env')`, "PowerShell", "block"],
    [(run) => `cmd ${run("/v:on")}/c type .env`, "PowerShell", "block"],
    // cmd's `if` and `for` nested many times over, and a here-document marker with many `(`.
    [(run) => `cmd /c ${run("if cmd /c ")}type .env`, "PowerShell", "stop"],
    [(run) => `${run("cmd /c if ")}type .env`, "PowerShell", "stop"],
    [(run) => `cmd /c "${run("for /f %i in (a) do ")}type .env"`, "PowerShell", "stop"],
    [(run) => `cmd /c "for /f %i in ${run("( ")}.env"`, "PowerShell", "stop"],
    [(run) => `true <<$(${run("(")}\ncat .env`, "Bash", "stop"],
    // Many here-documents waiting while a `$(` spans many lines, and many `for /f` sets glued to `do`.
    [(run) => `true ${run("<<a ")}$(${run("\n")})\ncat .env`, "Bash", "stop"],
    // A long word of `(` after a `for`, a `for` set of `(`, and many subshells in a row.
    [(run) => `cmd /c 'for %i in (a) do echo ${run("a(")}'`, "PowerShell", "allow"],
    [(run) => `cmd /c 'for %i in ${run("(")}'`, "PowerShell", "allow"],
    [(run) => `${run("(true) ")}; cat .env`, "Bash", "block"],
    [(run) => `cmd /c "${run("for /f %i in ('x')do ")}type .env"`, "PowerShell", "stop"],
    [(run) => `cat ${run('"a"*')} .env`, "Bash", "block"],
    [(run) => `cat ${run('"a" ')}"README.md"*`, "Bash", "allow"],
    // A glob at the end of a long path is found by joining the path's plain folders once. A path too long to look up
    // is judged by its name, which a `*` could make a secret file's, so it's stopped there ("stop": for any file).
    [(run) => `cat ${run("a/")}*; cat .env`, "Bash", "stop"],
    [(run) => `cat "${run("a/")}"*; cat .env`, "Cursor", "stop"],
  ];
  return commands.map(([build, toolName, action, counts]) => {
    const commandOf = (size) => build((text) => text.repeat(Math.ceil(size / text.length)), size);
    return [`${toolName} ${JSON.stringify(commandOf(24).slice(0, 24))}…`, commandOf, toolName, action, counts];
  });
}

module.exports = { quotedSeparatorShell, blankSpaceCommands, dottedOperandCommands, quotedRunCommands };
