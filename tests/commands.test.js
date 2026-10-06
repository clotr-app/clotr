// This tests the command check in extension/commands.js, which looks for a command copied on an AI chat that
// matches the "verify you're human: press Win+R and paste this" trick. It runs against the two command
// corpora in tests/corpus/command-*.txt: every trick should be found with the right shape, and every honest
// look-alike should stay quiet. What the page actually does with a detected trick is covered by the e2e
// suite's CG checks in 23-command-check.js.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { retrySlow, bestOfPair, grewMoreThan } = require("./timing.js");

require("../extension/commands.js");
const { commandTrick, commandShapes } = globalThis.Clotr;

// Reads a corpus file directly so this test stands alone. Each entry after the header starts with a label
// line, then a "copied:" field and an "around:" field.
function readCommandCorpus(file) {
  return fs
    .readFileSync(path.join(__dirname, "corpus", file), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((entry) => {
      const lines = entry.trim().split(/\r?\n/);
      const field = (name) =>
        lines
          .find((l) => l.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim() ?? "";
      return {
        label: (/^\[([^\]]+)\]/.exec(lines[0]) || [])[1] || "",
        copied: field("copied"),
        around: field("around"),
      };
    })
    .filter((e) => e.copied);
}

const lures = readCommandCorpus("command-lures.txt");
const honest = readCommandCorpus("command-lookalikes.txt");
const shapeOf = (e) => commandTrick(e.copied, e.around)?.shape ?? null;

test("the two corpora are well formed: labels, a copied line and its message, made-up addresses only", () => {
  assert.ok(lures.length >= 14, `${lures.length} tricks`);
  assert.ok(honest.length >= 45, `${honest.length} look-alikes`);
  for (const e of lures) {
    assert.match(e.label, /^lure: (download|hidden)$/, e.copied);
    assert.ok(e.copied && e.around, e.copied);
    for (const [, host] of `${e.copied} ${e.around}`.matchAll(/https?:\/\/([^/\s'"]+)/g))
      assert.match(host, /\.example\.invalid$/, `a real address in a trick: ${host}`);
  }
  for (const e of honest) {
    assert.equal(e.label, "honest", e.copied);
    assert.ok(e.copied && e.around, e.copied);
  }
});

test("every trick in the corpus is found, with the shape its label gives", () => {
  const wrong = lures.filter((e) => shapeOf(e) !== e.label.slice("lure: ".length));
  assert.deepEqual(
    wrong.map((e) => `${e.label} → ${shapeOf(e)}: ${e.copied}`),
    [],
  );
});

test("every honest look-alike stays quiet", () => {
  const loud = honest.filter((e) => commandTrick(e.copied, e.around));
  assert.deepEqual(
    loud.map((e) => `${shapeOf(e)}: ${e.copied}`),
    [],
  );
});

// Checks the copied text alone, then together with the message it came from. A download needs a trick signal
// from the message, or from the copied line itself when its address names the fake check. An encoded command
// or decoded text fed to a shell is enough on its own.
test("the copied text alone vs with its message", () => {
  for (const e of lures) {
    const alone = commandTrick(e.copied, "");
    const namesTheCheck = /captcha|robot|human/i.test(e.copied);
    if (e.label === "lure: download")
      assert.deepEqual(alone, namesTheCheck ? { shape: "download" } : null, `without its message: ${e.copied}`);
    else if (alone) assert.equal(alone.shape, "hidden", e.copied);
  }
  const needMessage = lures.filter((e) => e.label === "lure: download" && !commandTrick(e.copied, ""));
  assert.ok(needMessage.length >= 8, `${needMessage.length} downloads found only with their message`);
  const selfEvident = lures.filter((e) => commandTrick(e.copied, ""));
  assert.ok(selfEvident.length >= 2, "an encoded command and decoded text fed to a shell count on their own");
  // The message alone, with nothing risky copied, is never enough.
  for (const e of lures) assert.equal(commandTrick("msconfig", e.around), null, e.around);
});

// Checks each shape against the honest commands. A shape alone is only half of a trick.
test("shapes: downloads, hidden windows and encoded commands are told apart", () => {
  const byStart = (start) => honest.find((e) => e.copied.startsWith(start)).copied;
  assert.deepEqual(commandShapes(byStart("irm get.scoop.sh")), { download: true, hidden: false, hiddenWindow: false });
  assert.deepEqual(commandShapes(byStart("/bin/bash -c")), { download: true, hidden: false, hiddenWindow: false });
  assert.deepEqual(commandShapes(byStart("curl --proto")), { download: true, hidden: false, hiddenWindow: false });
  assert.deepEqual(commandShapes(byStart("Set-ExecutionPolicy Bypass -Scope Process")), {
    download: true,
    hidden: false,
    hiddenWindow: false,
  });
  // A hidden window running a file already on the computer counts as hidden, but not a download.
  assert.deepEqual(commandShapes(byStart("powershell -WindowStyle Hidden -File")), {
    download: false,
    hidden: false,
    hiddenWindow: true,
  });
  assert.deepEqual(commandShapes(byStart("powershell.exe -NoProfile -WindowStyle Hidden")), {
    download: false,
    hidden: false,
    hiddenWindow: true,
  });
  // Fetching without running, decoding without a shell, a notification, or a local installer has no shape at all.
  for (const start of [
    "Invoke-WebRequest -Uri",
    "iwr https://api.github.com",
    'echo "aGVsbG8="',
    "osascript -e",
    "msiexec /i C:",
    "certutil -hashfile",
    "rundll32.exe sysdm.cpl",
    "wget https://example.com",
  ])
    assert.deepEqual(commandShapes(byStart(start)), { download: false, hidden: false, hiddenWindow: false }, start);
  for (const e of lures.filter((l) => l.label === "lure: download"))
    assert.equal(commandShapes(e.copied).download, true, e.copied);
});

// Backup and logon scripts hide their window too, so a hidden window alone is never a trick. It only counts
// alongside a download, or a trick signal in the message.
test("a hidden window alone isn't a trick; with a trick signal it is", () => {
  const windowOnly = lures.filter((e) => {
    const s = commandShapes(e.copied);
    return s.hiddenWindow && !s.hidden && !s.download;
  });
  assert.ok(windowOnly.length >= 2, "the corpus has hidden-window tricks");
  for (const e of windowOnly) {
    assert.equal(commandTrick(e.copied, ""), null, `a hidden window alone: ${e.copied}`);
    assert.deepEqual(commandTrick(e.copied, e.around), { shape: "hidden" }, e.copied);
  }
});

// The Run-box steps for harmless programs carry a trick signal but no risky shape, and the honest installers
// carry a risky shape but no signal. Either half alone should stay quiet.
test("a trick signal with nothing risky copied, or a risky command with no signal, stays quiet", () => {
  const runBox = honest.filter((e) => /win(dows)?( key)? ?\+ ?r\b/i.test(e.around));
  assert.ok(runBox.length >= 4, `${runBox.length} Run-box steps`);
  for (const e of runBox) assert.equal(commandTrick(e.copied, e.around), null, e.copied);
  const installers = honest.filter((e) => commandShapes(e.copied).download);
  assert.ok(installers.length >= 8, `${installers.length} honest installers`);
});

test("never throws: empty, missing or odd input gives null", () => {
  for (const [a, b] of [
    [undefined, undefined],
    [null, null],
    ["", ""],
    [42, {}],
    [["x"], ["y"]],
    ["   \n\t ", "Press Win+R"],
  ])
    assert.equal(commandTrick(a, b), null, `${JSON.stringify(a)}, ${JSON.stringify(b)}`);
});

// Anything that reads text a page controls has to run in linear time. This builds 20,000 lines out of the
// pieces the check looks for, never completing a trick, and expects 4x the lines to take about 4x the time.
test("linear time on 20,000 lines of hostile text", () => {
  const pieces = [
    "powershell -w ",
    "iwr iwr iwr ",
    "curl curl | | ",
    "base64 -d base64 ",
    "mshta mshta ",
    "rundll32 ",
    "win+ win + ",
    "shared by shared by ",
    "verify you ",
    "$( $( <( ",
    "-enc -enc ",
    "\\\\ \\\\ ",
  ];
  const make = (lines) => Array.from({ length: lines }, (_, i) => pieces[i % pieces.length].repeat(4)).join("\n");
  const oneLine = (n) => pieces.join("").repeat(n);
  for (const [name, small, big] of [
    ["20,000 lines", make(5000), make(20000)],
    ["one long line", oneLine(1000), oneLine(4000)],
  ]) {
    retrySlow(() => {
      // Times the two sizes in turns, so a busy moment on the machine lands on both (see tests/timing.js).
      const [quick, t] = bestOfPair(
        () => commandTrick(small, small.slice(0, 4000)),
        () => commandTrick(big, big.slice(0, 4000)),
        4,
      );
      const grew = t.wall >= 50 && grewMoreThan(quick, t, 10);
      const growth = `${name}: ${quick.wall.toFixed(1)} → ${t.wall.toFixed(1)} ms for 4× the text`;
      if (t.over(400))
        return `${name}: ${t.wall.toFixed(0)} ms (${t.cpu.toFixed(0)} of processor, ${t.allowed.toFixed(0)} allowed on this computer now)`;
      if (grew) return growth;
    });
    assert.equal(commandTrick(big, big.slice(0, 4000)), null, name);
  }
});
