// Path forms Windows opens by another name, a drive's share on this computer, and the read hook's deadline for its own
// path checks. Every value here is made up and lives in a temporary folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.strictEqual(built.status, 0, built.stderr);
}
const guard = require("../apps/guard/bin/clotr-guard.js");
const mcp = require("../apps/guard/bin/clotr-mcp.js");

const WINDOWS_ONLY = process.platform === "win32" ? false : "Windows path forms";

function tempDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clotr-forms-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

// A secret file, an ordinary one, .kube/config behind a junction with an ordinary name (any Windows account can make
// one), and a folder holding a .env behind another.
function fixture(t) {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "notes\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "readme.md"), "readme\n");
  fs.mkdirSync(path.join(root, ".kube"));
  fs.writeFileSync(path.join(root, ".kube", "config"), "token: synthetic-not-real-123\n");
  fs.mkdirSync(path.join(root, "proj"));
  fs.writeFileSync(path.join(root, "proj", ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  if (process.platform === "win32") {
    fs.symlinkSync(path.join(root, ".kube"), path.join(root, "kubelink"), "junction");
    fs.symlinkSync(path.join(root, "proj"), path.join(root, "projlink"), "junction");
  }
  return root;
}

function shortNameOf(root, short, long) {
  try {
    return path.basename(fs.realpathSync.native(path.join(root, short))) === long ? short : null;
  } catch {
    return null;
  }
}

// Every check a path reaches, in each client format the hooks read: Claude Code, Cursor, Gemini CLI and Codex reads,
// Claude Code's Bash and PowerShell and Cursor's shell, and the MCP tool.
function pathChecks(root) {
  const read = (tool, file) => {
    const event =
      tool === "claude"
        ? { tool_name: "Read", tool_input: { file_path: file } }
        : tool === "cursor"
          ? { file_path: file, content: "notes\n" }
          : tool === "gemini"
            ? { tool_name: "read_file", tool_input: { absolute_path: file } }
            : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
    return guard.inspectRead(tool, event, { cwd: root }).action;
  };
  const shell = (tool, toolName, command) =>
    (tool === "cursor"
      ? guard.inspectShell("cursor", { command, cwd: root }, { cwd: root })
      : guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root })
    ).action;
  return {
    "Claude Code Read": (file) => read("claude", file),
    "Cursor read": (file) => read("cursor", file),
    "Gemini CLI read_file": (file) => read("gemini", file),
    "Codex read": (file) => read("codex", file),
    "Bash cat": (file) => shell("claude", "Bash", `cat '${file.replace(/\\/g, "/")}'`),
    "Bash redirect": (file) => shell("claude", "Bash", `tr a b < '${file.replace(/\\/g, "/")}'`),
    "PowerShell Get-Content": (file) => shell("claude", "PowerShell", `Get-Content -LiteralPath '${file}'`),
    "cmd type": (file) => shell("claude", "PowerShell", `cmd /c type "${file}"`),
    "Cursor shell": (file) => shell("cursor", null, `type "${file}"`),
    // The MCP tool reads a relative path from its own folder, so it's given the path in the test folder.
    "MCP is_secret_file": (file) =>
      mcp.callTool("is_secret_file", { path: /^(?:[A-Za-z]:|[\\/])/.test(file) ? file : path.join(root, file) })
        .is_secret_file
        ? "block"
        : "allow",
  };
}

function expectAll(checks, files, expected) {
  for (const file of files) {
    for (const [name, run] of Object.entries(checks)) assert.equal(run(file), expected, `${name} ${file}`);
  }
}

test("a part ending in a dot, a space or a stream name is judged as Windows opens it", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const checks = pathChecks(root);
  // PowerShell's Get-Content and cmd's type drop a part's last dot, and the last part's dots and spaces, so these
  // open .kube/config through the junction, or the .env the short name stands for.
  const relative = ["kubelink.\\config", "kubelink.\\config.", "kubelink\\config. .", "kubelink\\config::$DATA"];
  const envShort = shortNameOf(root, "ENV~1", ".env");
  if (envShort) relative.push(`${envShort}.`, `${envShort} `, `${envShort}. .`, `docs\\..\\${envShort}.`);
  else t.diagnostic("this volume doesn't make short names, so only the junction forms were tried");
  expectAll(checks, [...relative, ...relative.map((file) => path.join(root, file))], "block");
  for (const file of relative) assert.equal(guard.isSecretPath(file, "", root), true, `isSecretPath ${file}`);
  // A part that only looks like those, and an ordinary file written with them, still goes through.
  expectAll(checks, ["notes.txt.", "notes.txt ", "docs.\\readme.md", path.join(root, "docs.", "readme.md.")], "allow");
});

test(
  "a recursive reader or search of a folder written with a last dot reads the folder it opens",
  {
    skip: WINDOWS_ONLY,
  },
  (t) => {
    const root = fixture(t);
    const shell = (command, toolName = "PowerShell") =>
      guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
    for (const command of [
      "grep -r DB_ projlink.",
      `grep -r DB_ '${root.replace(/\\/g, "/")}/projlink.'`,
      "rg --hidden DB_ projlink.",
      "findstr /s DB_ projlink.\\*",
      "Get-Content projlink.\\*",
    ]) {
      assert.equal(shell(command), "block", command);
    }
    assert.equal(
      guard.inspectShell("cursor", { command: "grep -r DB_ projlink.", cwd: root }, { cwd: root }).action,
      "block",
    );
    assert.equal(shell("grep -r DB_ docs."), "allow");
    const search = (tool, event) => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }).action;
    assert.equal(
      search("claude", {
        tool_name: "Grep",
        tool_input: { pattern: "DB_", path: "projlink.", output_mode: "content" },
      }),
      "block",
    );
    assert.equal(
      search("gemini", { tool_name: "search_file_content", tool_input: { pattern: "DB_", dir_path: "projlink." } }),
      "block",
    );
    assert.equal(
      search("claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: "docs.", output_mode: "content" } }),
      "allow",
    );
  },
);

// Every way a share name can reach this computer's own drive.
function loopbackShares(root) {
  const letter = root[0];
  const rest = root.slice(2);
  const hosts = ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.1", "127.0.0.2", os.hostname()];
  const shares = [];
  for (const host of hosts) shares.push(`\\\\${host}\\${letter}$${rest}`);
  shares.push(
    `\\\\localhost\\${letter.toLowerCase()}$${rest}`,
    `//localhost/${letter}$${rest.replace(/\\/g, "/")}`,
    `\\\\.\\UNC\\localhost\\${letter}$${rest}`,
    `\\\\?\\UNC\\localhost\\${letter}$${rest}`,
    `\\??\\UNC\\127.0.0.1\\${letter}$${rest}`,
    `\\\\?\\UNC\\[::1]\\${letter}$${rest}`,
    `\\\\0--1.ipv6-literal.net\\${letter}$${rest}`,
    `\\\\.\\GLOBALROOT\\??\\UNC\\localhost\\${letter}$${rest}`,
    `\\\\.\\GLOBALROOT\\Device\\Mup\\localhost\\${letter}$${rest}`,
  );
  return shares;
}

test("a drive's share on this computer is checked as the drive path it opens", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const checks = pathChecks(root);
  const shares = loopbackShares(root);
  expectAll(
    checks,
    shares.map((share) => `${share}\\kubelink\\config`),
    "block",
  );
  const envShort = shortNameOf(root, "ENV~1", ".env");
  if (envShort) expectAll(checks, [`${shares[0]}\\${envShort}`, `${shares[0]}\\${envShort}.`], "block");
  for (const share of shares) {
    assert.equal(guard.isSecretPath(`${share}\\kubelink\\config`), true, share);
    assert.equal(guard.isSecretPath("kubelink\\config", "", share), true, `relative in ${share}`);
  }
  // A recursive reader, a search and a working folder on the share reach the same folder.
  const shell = (command, cwd = root) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd } }, { cwd }).action;
  assert.equal(shell(`grep -r DB_ '${shares[0].replace(/\\/g, "/")}/projlink'`), "block");
  assert.equal(shell("cat kubelink/config", shares[0]), "block");
  assert.equal(
    guard.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "DB_", path: `${shares[0]}\\projlink`, output_mode: "content" } },
      { cwd: root, searchWalkMaxMs: 10000 },
    ).action,
    "block",
  );
  // An ordinary file there goes through, and is read from the drive so its text is checked like the drive path's.
  expectAll(checks, [`${shares[0]}\\notes.txt`, `${shares[0]}\\docs\\readme.md`], "allow");
  fs.writeFileSync(path.join(root, "aws.txt"), `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`);
  const keyed = guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: `${shares[0]}\\aws.txt` } });
  assert.equal(keyed.action, "block");
  assert.ok(!keyed.internalError);
  otherComputersShareByName(t, root);
});

// A drive's share on another computer is judged by name: the drive path's own name, never looked up there (see
// guard-network-paths.test.js) or on this computer's drive, where the same path is some other file.
function otherComputersShareByName(t, root) {
  const letter = root[0];
  const rest = root.slice(2);
  const touched = [];
  const watched = ["lstatSync", "statSync", "realpathSync", "openSync", "opendirSync", "readdirSync", "existsSync"];
  const originals = {};
  const native = fs.realpathSync.native;
  for (const name of watched) {
    originals[name] = fs[name];
    fs[name] = function (...args) {
      if (typeof args[0] === "string" && (args[0].includes(rest) || /fileserver\.example/i.test(args[0]))) {
        touched.push(`${name} ${args[0]}`);
      }
      return originals[name].apply(this, args);
    };
  }
  fs.realpathSync.native = function (...args) {
    if (typeof args[0] === "string" && (args[0].includes(rest) || /fileserver\.example/i.test(args[0]))) {
      touched.push(`realpathSync.native ${args[0]}`);
    }
    return native.apply(this, args);
  };
  t.after(() => {
    for (const name of watched) fs[name] = originals[name];
    fs.realpathSync.native = native;
  });
  const untouched = (label, run) => {
    touched.length = 0;
    const result = run();
    assert.deepEqual(touched, [], `${label} looked a path up`);
    return result;
  };
  for (const share of [
    `\\\\fileserver.example\\${letter}$${rest}`,
    `\\\\?\\UNC\\fileserver.example\\${letter}$${rest}`,
    `\\\\.\\UNC\\fileserver.example\\${letter.toLowerCase()}$${rest}`,
    `//fileserver.example/${letter}$${rest.replace(/\\/g, "/")}`,
    `\\\\.\\GLOBALROOT\\Device\\Mup\\fileserver.example\\${letter}$${rest}`,
  ]) {
    // By name: the drive path's own name, with no lookup to see a link or short name behind it.
    assert.equal(
      untouched(share, () => guard.isSecretPath(`${share}\\kubelink\\config`)),
      false,
    );
    assert.equal(
      untouched(share, () => guard.isSecretPath(`${share}\\.kube\\config`)),
      true,
    );
    assert.equal(
      untouched(share, () => guard.isSecretPath(`${share}\\proj\\..\\.env.`)),
      true,
    );
    // Run from the folder above, so a word in the command looked up there isn't taken for a lookup on the drive path.
    const cwd = path.dirname(root);
    const shell = (command, toolName = "Bash") =>
      untouched(command, () =>
        guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd } }, { cwd }),
      ).action;
    // A shell reads the `?` of `\\?\UNC` as a wildcard, and a wildcard on another computer that could match a secret
    // file's name is held, so that form is only tried outside a shell.
    const unix = share.replace(/\\/g, "/");
    if (!share.includes("?")) {
      assert.equal(shell(`cat '${unix}/kubelink/config'`), "allow");
      assert.equal(shell(`cat '${unix}/.kube/config.'`), "block");
      assert.equal(shell(`grep -r DB_ '${unix}/projlink'`), "allow");
      assert.equal(shell(`Get-Content -LiteralPath '${share}\\kubelink\\config'`, "PowerShell"), "allow");
      assert.equal(shell(`Get-Content -LiteralPath '${share}\\.kube\\config'`, "PowerShell"), "block");
    }
    const read = untouched(share, () =>
      guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: `${share}\\notes.txt` } }),
    );
    assert.deepEqual(read, { action: "allow", internalError: true });
  }
  for (const name of watched) fs[name] = originals[name];
  fs.realpathSync.native = native;
}

// The read hook's own path checks share its deadline: a slow lookup doesn't hold the hook past it.
test("the read hook's path checks stop at its deadline and the read is held as unfinished", (t) => {
  const root = fixture(t);
  const STEP_MS = 250;
  const started = [];
  const slow = (original) =>
    function (...args) {
      if (typeof args[0] === "string" && args[0].includes(root)) {
        started.push(Date.now());
        const until = Date.now() + STEP_MS;
        while (Date.now() < until) {
          // A lookup on a slow or busy disk.
        }
      }
      return original.apply(this, args);
    };
  const { lstatSync, realpathSync, statSync } = fs;
  const native = realpathSync.native;
  fs.lstatSync = slow(lstatSync);
  fs.statSync = slow(statSync);
  fs.realpathSync = slow(realpathSync);
  fs.realpathSync.native = slow(native);
  t.after(() => {
    fs.lstatSync = lstatSync;
    fs.statSync = statSync;
    fs.realpathSync = realpathSync;
  });
  for (const [tool, event] of [
    ["claude", { tool_name: "Read", tool_input: { file_path: "notes.txt" } }],
    ["gemini", { tool_name: "read_file", tool_input: { absolute_path: path.join(root, "notes.txt") } }],
    ["codex", { tool_name: "mcp__fs__read_file", tool_input: { path: "notes.txt" } }],
    ["cursor", { file_path: "notes.txt", content: "notes\n" }],
  ]) {
    started.length = 0;
    const deadline = Date.now() + 400;
    const outcome = guard.inspectRead(tool, event, { cwd: root, deadline });
    const finished = Date.now();
    assert.equal(outcome.action, "block", tool);
    assert.equal(outcome.unfinished, true, tool);
    assert.ok(started.length > 0, `${tool}: the slow lookup ran`);
    assert.deepEqual(
      started.filter((at) => at >= deadline),
      [],
      `${tool}: a lookup started after the deadline`,
    );
    assert.ok(finished < deadline + STEP_MS + 1000, `${tool} took ${finished - deadline} ms past the deadline`);
  }
  // From the command line, the hook's start sets the deadline.
  started.length = 0;
  const startedAt = Date.now();
  const outcome = guard.inspectRead(
    "claude",
    { tool_name: "Read", tool_input: { file_path: "notes.txt" } },
    { cwd: root, startedAt, hookCheckMaxMs: 400 },
  );
  assert.equal(outcome.unfinished, true);
  assert.deepEqual(
    started.filter((at) => at >= startedAt + 400),
    [],
  );
  assert.ok(
    guard.readHookOutput("claude", outcome).stdout.includes("ran out of time"),
    "the read is put to the person as one that wasn't checked",
  );
});

// The drive's own volume as the system names it: `\\?\Volume{...}\` (from mountvol) and
// `\\?\GLOBALROOT\Device\HarddiskVolumeN\`, found by trying each N. Null for a name that can't be found.
function volumeNames(root) {
  const names = [];
  try {
    const volume = execFileSync("mountvol", [`${root.slice(0, 2)}\\`, "/L"], { encoding: "utf8" }).trim();
    if (/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(volume)) names.push(volume.slice(0, -1));
  } catch {
    // No mountvol: the device name below is still tried.
  }
  const opens = (device) => {
    try {
      return fs.realpathSync.native(`${device}${root.slice(2)}`) === root;
    } catch {
      return false;
    }
  };
  for (let number = 1; number <= 64; number += 1) {
    const device = `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume${number}`;
    if (opens(device)) {
      names.push(device, device.replace("\\\\?\\", "\\\\.\\"));
      break;
    }
  }
  return names;
}

// The volume's other names in the system's namespace, each tried: the volume's own name without GLOBALROOT, its disk
// and partition, the boot volume's names and, written with brackets a shell reads apart, its ARC name.
function volumeAliases(root) {
  const opens = (device) => {
    try {
      return fs.realpathSync.native(`${device}${root.slice(2)}`) === root;
    } catch {
      return false;
    }
  };
  const aliases = [];
  const arcNames = [];
  for (let number = 1; number <= 64; number += 1) {
    if (!opens(`\\\\?\\GLOBALROOT\\Device\\HarddiskVolume${number}`)) continue;
    aliases.push(
      `\\\\.\\HarddiskVolume${number}`,
      `\\\\?\\HarddiskVolume${number}`,
      `\\\\.\\GLOBALROOT\\GLOBAL??\\HarddiskVolume${number}`,
      `\\\\?\\Global\\HarddiskVolume${number}`,
    );
    break;
  }
  for (let disk = 0; disk < 8; disk += 1) {
    for (let partition = 1; partition <= 16; partition += 1) {
      if (!opens(`\\\\?\\GLOBALROOT\\Device\\Harddisk${disk}\\Partition${partition}`)) continue;
      aliases.push(
        `\\\\.\\GLOBALROOT\\Device\\Harddisk${disk}\\Partition${partition}`,
        `\\\\.\\Harddisk${disk}Partition${partition}`,
      );
      const arc = `\\\\.\\GLOBALROOT\\ArcName\\multi(0)disk(0)rdisk(${disk})partition(${partition})`;
      if (opens(arc)) arcNames.push(arc);
    }
  }
  for (const device of [
    "\\\\.\\GLOBALROOT\\Device\\BootDevice",
    "\\\\.\\GLOBALROOT\\Device\\BootPartition",
    "\\\\.\\BootPartition",
  ]) {
    if (opens(device)) aliases.push(device);
  }
  return { aliases, arcNames };
}

test(
  "a drive's volume by any of its other names in the system's namespace is checked as the drive path",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const checks = pathChecks(root);
    const rest = root.slice(2);
    const { aliases, arcNames } = volumeAliases(root);
    t.diagnostic(`${aliases.length} names and ${arcNames.length} ARC names for the test folder's volume`);
    assert.ok(aliases.length >= 4, "the volume's own names are found");
    expectAll(
      checks,
      aliases.map((alias) => `${alias}${rest}\\kubelink\\config`),
      "block",
    );
    expectAll(
      checks,
      aliases.map((alias) => `${alias}${rest}\\kubelink.\\config`),
      "block",
    );
    expectAll(
      checks,
      aliases.map((alias) => `${alias}${rest}\\notes.txt`),
      "allow",
    );
    const outsideShell = Object.fromEntries(
      Object.entries(checks).filter(([name]) => /Read|read|MCP/.test(name) && !/Bash|PowerShell|cmd|shell/.test(name)),
    );
    expectAll(
      outsideShell,
      arcNames.map((alias) => `${alias}${rest}\\kubelink\\config`),
      "block",
    );
    expectAll(
      outsideShell,
      arcNames.map((alias) => `${alias}${rest}\\notes.txt`),
      "allow",
    );
    // A read's contents are checked from the drive, so an ordinary file read through one isn't left unchecked.
    const read = (file) => {
      const outcome = guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } });
      delete outcome.location;
      return outcome;
    };
    assert.deepEqual(read(`${aliases[0]}${rest}\\notes.txt`), read(path.join(root, "notes.txt")));
    fs.writeFileSync(path.join(root, "aws.txt"), `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`);
    for (const alias of aliases) {
      const keyed = read(`${alias}${rest}\\aws.txt`);
      assert.equal(keyed.action, "block", alias);
      assert.ok(!keyed.internalError, alias);
    }
  },
);

test(
  "a search, a recursive reader or a read through a device path to a drive reads the drive's folder",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, "aws.txt"), `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`);
    const search = (tool, event) => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }).action;
    const shell = (command, toolName = "PowerShell") =>
      guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
    for (const device of [`\\\\?\\${root}`, `\\\\.\\${root}`, `\\??\\${root}`]) {
      for (const folder of ["proj", "projlink"]) {
        const at = `${device}\\${folder}`;
        assert.equal(
          search("claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: at, output_mode: "content" } }),
          "block",
          `Grep ${at}`,
        );
        assert.equal(
          search("gemini", { tool_name: "search_file_content", tool_input: { pattern: "DB_", dir_path: at } }),
          "block",
          `search_file_content ${at}`,
        );
        assert.equal(shell(`rg --hidden DB_ '${at}'`), "block", `rg ${at}`);
        assert.equal(shell(`findstr /s DB_ '${at}\\*'`), "block", `findstr ${at}`);
        if (!device.includes("?")) assert.equal(shell(`grep -r DB_ '${at.replace(/\\/g, "/")}'`, "Bash"), "block", at);
      }
      // An ordinary folder still goes through.
      assert.equal(
        search("claude", {
          tool_name: "Grep",
          tool_input: { pattern: "DB_", path: `${device}\\docs`, output_mode: "content" },
        }),
        "allow",
      );
      assert.equal(shell(`rg DB_ '${device}\\docs'`), "allow");
      // A read is checked from the drive: its text too.
      for (const tool of ["claude", "gemini", "codex"]) {
        const event = (file) =>
          tool === "claude"
            ? { tool_name: "Read", tool_input: { file_path: file } }
            : tool === "gemini"
              ? { tool_name: "read_file", tool_input: { absolute_path: file } }
              : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
        const keyed = guard.inspectRead(tool, event(`${device}\\aws.txt`), { cwd: root });
        assert.equal(keyed.action, "block", `${tool} ${device}\\aws.txt`);
        assert.ok(!keyed.internalError, `${tool} ${device}\\aws.txt`);
        const plain = guard.inspectRead(tool, event(`${device}\\notes.txt`), { cwd: root });
        assert.equal(plain.action, "allow", `${tool} ${device}\\notes.txt`);
        assert.ok(!plain.internalError, `${tool} ${device}\\notes.txt was checked`);
      }
    }
  },
);

test(
  "a share path with dots below the share, a search of a secret folder itself, and a read under two names are caught",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const letter = root[0];
    const rest = root.slice(2);
    const checks = pathChecks(root);
    // `\\?\` and `\??\` pass `.` and `..` on, but below the share they open the same file (where the system resolves
    // them) or nothing, so the path is still this computer's drive path.
    const shares = [
      `\\\\?\\UNC\\localhost\\${letter}$${rest}`,
      `\\??\\UNC\\localhost\\${letter}$${rest}`,
      `\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\${letter}$${rest}`,
    ];
    const dotted = shares.flatMap((share) => [
      `${share}\\.\\kubelink\\config::$DATA`,
      `${share}\\docs\\..\\kubelink\\config::$DATA`,
      `${share}\\.\\kubelink\\config`,
    ]);
    expectAll(checks, dotted, "block");
    for (const file of dotted) assert.equal(guard.isSecretPath(file), true, file);
    fs.writeFileSync(path.join(root, "aws.txt"), `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`);
    const read = (tool, file) =>
      guard.inspectRead(
        tool,
        tool === "claude"
          ? { tool_name: "Read", tool_input: { file_path: file } }
          : tool === "gemini"
            ? { tool_name: "read_file", tool_input: { absolute_path: file } }
            : { tool_name: "mcp__fs__read_file", tool_input: { path: file } },
        { cwd: root },
      );
    for (const tool of ["claude", "gemini", "codex"]) {
      const keyed = read(tool, `${shares[0]}\\docs\\..\\aws.txt`);
      assert.equal(keyed.action, "block", `${tool} dotted aws.txt`);
      assert.ok(!keyed.internalError, `${tool} dotted aws.txt was read`);
      const plain = read(tool, `${shares[0]}\\.\\notes.txt`);
      assert.equal(plain.action, "allow", `${tool} dotted notes.txt`);
      assert.ok(!plain.internalError, `${tool} dotted notes.txt was read`);
      // A `..` that climbs from another computer's name to this one's is looked up here for a link, but a program
      // that passes it on opens the other computer's file, so a read there isn't checked from the drive.
      const climbed = `\\\\?\\UNC\\fileserver.example\\x\\..\\..\\localhost\\${letter}$${rest}`;
      assert.equal(read(tool, `${climbed}\\kubelink\\config`).action, "block", `${tool} climbed kubelink`);
      assert.ok(read(tool, `${climbed}\\aws.txt`).internalError, `${tool} climbed aws.txt`);
    }

    // A search of `.kube` itself, or of a link to it, reads `config` there, however the folder is written.
    const search = (tool, event) => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }).action;
    const shell = (command, toolName = "PowerShell") =>
      guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
    const folders = [".kube", "kubelink"].flatMap((folder) => [
      path.join(root, folder),
      `\\\\?\\${root}\\${folder}`,
      `\\\\.\\${root}\\${folder}`,
      `\\\\localhost\\${letter}$${rest}\\${folder}`,
    ]);
    for (const at of folders) {
      assert.equal(
        search("claude", { tool_name: "Grep", tool_input: { pattern: "token", path: at, output_mode: "content" } }),
        "block",
        `Grep ${at}`,
      );
      assert.equal(
        search("gemini", { tool_name: "search_file_content", tool_input: { pattern: "token", dir_path: at } }),
        "block",
        `search_file_content ${at}`,
      );
      assert.equal(shell(`rg --hidden token '${at}'`), "block", `rg ${at}`);
      if (!at.includes("?")) assert.equal(shell(`grep -r token '${at.replace(/\\/g, "/")}'`, "Bash"), "block", at);
    }
    assert.equal(
      search("claude", {
        tool_name: "Grep",
        tool_input: { pattern: "token", path: "kubelink", output_mode: "content" },
      }),
      "block",
    );
    assert.equal(
      search("claude", { tool_name: "Grep", tool_input: { pattern: "readme", path: "docs", output_mode: "content" } }),
      "allow",
    );

    // A read whose path opens one file in Node and another where Windows tidies it (`keys.txt.` opens `keys.txt`
    // behind `\\.\` and in most programs) checks both, so a file planted under the other name can't stand in.
    fs.writeFileSync(`\\\\?\\${root}\\aws.txt.`, "notes\n");
    for (const tool of ["claude", "gemini", "codex"]) {
      for (const file of [`\\\\.\\${root}\\aws.txt.`, `${root}\\aws.txt.`]) {
        const keyed = read(tool, file);
        assert.equal(keyed.action, "block", `${tool} ${file}`);
        assert.ok(!keyed.internalError, `${tool} ${file} was read`);
      }
    }
    fs.writeFileSync(`\\\\?\\${root}\\notes.txt.`, "notes\n");
    for (const tool of ["claude", "gemini", "codex"]) {
      const plain = read(tool, `\\\\.\\${root}\\notes.txt.`);
      assert.equal(plain.action, "allow", `${tool} notes.txt.`);
      assert.ok(!plain.internalError, `${tool} notes.txt. was read`);
    }
    // What one read has to say is said when every read goes through: here the file `\\.\` opens is past the cap.
    fs.writeFileSync(path.join(root, "big.log"), "x\n".repeat(200_000));
    fs.writeFileSync(`\\\\?\\${root}\\big.log.`, "notes\n");
    for (const tool of ["claude", "gemini", "codex"]) {
      const big = read(tool, `\\\\.\\${root}\\big.log.`);
      assert.equal(big.action, "allow", `${tool} big.log.`);
      assert.ok(big.partial, `${tool} big.log. was noted as read in part`);
    }
  },
);

test(
  "a read of a named stream through a device path, a share or a volume name reads the stream",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const letter = root[0];
    const rest = root.slice(2);
    const key = `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`;
    fs.writeFileSync(`${root}\\notes.txt:hidden`, key);
    fs.writeFileSync(`${root}\\docs:hidden`, key);
    const read = (tool, file) =>
      guard.inspectRead(
        tool,
        tool === "claude"
          ? { tool_name: "Read", tool_input: { file_path: file } }
          : tool === "gemini"
            ? { tool_name: "read_file", tool_input: { absolute_path: file } }
            : { tool_name: "mcp__fs__read_file", tool_input: { path: file } },
        { cwd: root },
      );
    const starts = [
      `\\\\.\\${root}`,
      `\\\\?\\${root}`,
      `\\\\localhost\\${letter}$${rest}`,
      `\\\\?\\UNC\\localhost\\${letter}$${rest}`,
      ...volumeNames(root).map((volume) => `${volume}${rest}`),
    ];
    for (const start of starts) {
      for (const name of ["notes.txt:hidden", "notes.txt:hidden:$DATA", "docs:hidden"]) {
        for (const tool of ["claude", "gemini", "codex"]) {
          const outcome = read(tool, `${start}\\${name}`);
          assert.equal(outcome.action, "block", `${tool} ${start}\\${name}`);
          assert.ok(!outcome.internalError, `${tool} ${start}\\${name} was read`);
        }
      }
    }
    for (const tool of ["claude", "gemini", "codex"]) {
      assert.equal(read(tool, `\\\\.\\${root}\\notes.txt:hidden.`).action, "block", `${tool} :hidden.`);
      // The file's own text is still what a plain read of it gets.
      const plain = read(tool, `\\\\.\\${root}\\notes.txt::$DATA`);
      assert.equal(plain.action, "allow", `${tool} ::$DATA`);
      assert.ok(!plain.internalError, `${tool} ::$DATA was read`);
    }
    // The stream on the last part the path opens, after `.` and `..`, is the one read.
    for (const start of starts.slice(0, 4)) {
      for (const tail of ["\\.", "\\sub\\..", "\\"]) {
        for (const tool of ["claude", "gemini", "codex"]) {
          const outcome = read(tool, `${start}\\notes.txt:hidden${tail}`);
          assert.equal(outcome.action, "block", `${tool} ${start}\\notes.txt:hidden${tail}`);
          assert.ok(!outcome.internalError, `${tool} ${start}\\notes.txt:hidden${tail} was read`);
        }
      }
    }
    // A one-letter file's stream is a stream, not a drive: `a:hidden.` behind `\\.\` opens `a:hidden`, so both are
    // read, also on the drive path itself, which most programs open the way `\\.\` does.
    fs.writeFileSync(path.join(root, "a"), "notes\n");
    fs.writeFileSync(`${root}\\a:hidden`, key);
    fs.writeFileSync(`\\\\?\\${root}\\a:hidden.`, "notes\n");
    for (const file of [`\\\\.\\${root}\\a:hidden.`, `${root}\\a:hidden.`]) {
      for (const tool of ["claude", "gemini", "codex"]) {
        const outcome = read(tool, file);
        assert.equal(outcome.action, "block", `${tool} ${file}`);
        assert.ok(!outcome.internalError, `${tool} ${file} was read`);
      }
    }
    // A path whose parts come down to one name, read from a share on this computer as the working folder, still
    // opens that name's stream. (A relative `a:hidden` names drive A:, not a stream.)
    const share = `\\\\localhost\\${letter}$${rest}`;
    for (const file of [
      "notes.txt:hidden",
      ".\\notes.txt:hidden",
      "docs\\..\\notes.txt:hidden",
      "./notes.txt:hidden.",
    ]) {
      for (const tool of ["claude", "gemini", "codex"]) {
        const event =
          tool === "claude"
            ? { tool_name: "Read", tool_input: { file_path: file } }
            : tool === "gemini"
              ? { tool_name: "read_file", tool_input: { absolute_path: file } }
              : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
        const outcome = guard.inspectRead(tool, event, { cwd: share });
        assert.equal(outcome.action, "block", `${tool} ${file} in ${share}`);
        assert.ok(!outcome.internalError, `${tool} ${file} in ${share} was read`);
      }
    }
  },
);

test(
  "a device path whose root ends in a dot, a space or a stream name is a name Guard can't place, so it's stopped unlooked-up",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const checks = pathChecks(root);
    const letter = root[0];
    const rest = root.slice(2);
    const volumes = volumeNames(root);
    // `\\?\` and `\??\` open the root as written, so `\\?\C:.\` is a DOS device a program could define as `C:.`
    // pointing anywhere, not the drive. A stream name on a root (`HarddiskVolume3:x`) is part of the name the system
    // looks up, behind `\\.\` too.
    const odd = [
      ...volumes
        .flatMap((volume) => [volume, volume.replace(/GLOBALROOT\\Device\\/i, "")])
        .map((volume) => `${volume}:x${rest}`),
      `\\\\?\\UNC:x\\localhost\\${letter}$${rest}`,
      `\\\\.\\UNC:x\\localhost\\${letter}$${rest}`,
      `\\\\?\\Global:x\\${letter}:${rest}`,
      `\\\\.\\GLOBALROOT:x\\??\\${letter}:${rest}`,
      `\\\\.\\GLOBALROOT\\??:x\\${letter}:${rest}`,
      `\\\\?\\${letter}:.${rest}`,
      `\\\\?\\${letter}: ${rest}`,
      `\\??\\${letter}:.${rest}`,
      `//?/${letter}:.${rest.replace(/\\/g, "/")}`,
      `\\\\?\\Global.\\${letter}:${rest}`,
      `\\\\?\\GLOBALROOT.\\??\\${letter}:${rest}`,
      `\\\\?\\UNC.\\localhost\\${letter}$${rest}`,
      ...volumes.filter((volume) => volume.startsWith("\\\\?\\")).map((volume) => `${volume}.${rest}`),
      // `\\.\` drops only a part's one last dot, so `\\.\C: \`, `\\.\C:. \` and `\\.\C:..\` are names too.
      `\\\\.\\${letter}: ${rest}`,
      `\\\\.\\${letter}:. ${rest}`,
      `\\\\.\\${letter}:..${rest}`,
      `//./${letter}: ${rest.replace(/\\/g, "/")}`,
      `\\\\.\\Global \\${letter}:${rest}`,
      `\\\\.\\GLOBALROOT \\??\\${letter}:${rest}`,
      `\\\\.\\UNC \\localhost\\${letter}$${rest}`,
      `\\\\.\\UNC..\\localhost\\${letter}$${rest}`,
      ...volumes.filter((volume) => volume.startsWith("\\\\.\\")).map((volume) => `${volume} ${rest}`),
    ];
    const untouched = watchLookups(
      t,
      (value) =>
        /:x[\\/]/.test(value) ||
        /(?:^|[\\/])(?:[A-Za-z]:[. ]*|Global|GLOBALROOT|UNC|[^\\/]*(?:\}|Volume\d+))(?: |\.\.|\. )[\\/]/i.test(value) ||
        /^(?:[\\/]{2}\?|\\\?\?)[\\/](?:[A-Za-z]:[. ]|Global\.|GLOBALROOT\.|UNC\.|.*(?:\}|Volume\d+)\.[\\/])/i.test(
          value,
        ),
    );
    for (const device of odd) {
      for (const [name, run] of Object.entries(checks)) {
        for (const file of [`${device}\\kubelink\\config`, `${device}\\notes.txt`]) {
          assert.equal(
            untouched(file, () => run(file)),
            "block",
            `${name} ${file}`,
          );
        }
      }
      const shell = (command, toolName = "PowerShell") =>
        untouched(command, () =>
          guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }),
        ).action;
      assert.equal(shell(`grep -r DB_ '${device}\\projlink'`), "block", device);
      assert.equal(shell(`findstr /s DB_ '${device}\\projlink\\*'`), "block", device);
      for (const [tool, event] of [
        [
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: `${device}\\docs`, output_mode: "content" } },
        ],
        ["gemini", { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: `${device}\\docs` } }],
      ]) {
        const search = untouched(device, () => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }));
        assert.equal(search.action, "block", `${tool} ${device}`);
      }
    }
    // `\\.\` tidies the root as it does the rest, so `\\.\C:.\` is the drive, and an ordinary file there is read.
    expectAll(checks, [`\\\\.\\${letter}:.${rest}\\notes.txt`], "allow");
    expectAll(checks, [`\\\\.\\${letter}:.${rest}\\kubelink\\config`], "block");
  },
);

test(
  "a drive-relative path read from a share as the working folder is stopped, as Guard can't tell which folder it opens",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const letter = root[0];
    const rest = root.slice(2);
    // `C:Users\...` opens below drive C's own working folder, which a process on a share can't see, so Guard can't
    // place it; a link or a secret file there would otherwise be judged by name only.
    const relative = (tail) => `${letter}:${rest.slice(1)}\\${tail}`;
    const read = (tool, file, cwd) =>
      guard.inspectRead(
        tool,
        tool === "claude"
          ? { tool_name: "Read", tool_input: { file_path: file } }
          : tool === "gemini"
            ? { tool_name: "read_file", tool_input: { absolute_path: file } }
            : { tool_name: "mcp__fs__read_file", tool_input: { path: file } },
        { cwd },
      ).action;
    const untouched = watchLookups(t, (value) => /fileserver\.example/i.test(value));
    for (const share of [`\\\\localhost\\${letter}$${rest}`, "\\\\fileserver.example\\share\\proj"]) {
      for (const tail of ["kubelink\\config", "notes.txt", "notes.txt:hidden"]) {
        const file = relative(tail);
        for (const tool of ["claude", "gemini", "codex"]) {
          assert.equal(
            untouched(file, () => read(tool, file, share)),
            "block",
            `${tool} ${file} in ${share}`,
          );
        }
        for (const [toolName, command] of [
          ["Bash", `cat '${file.replace(/\\/g, "/")}'`],
          ["PowerShell", `Get-Content '${file}'`],
        ]) {
          const outcome = untouched(command, () =>
            guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: share } }, { cwd: share }),
          );
          assert.equal(outcome.action, "block", `${toolName} ${command} in ${share}`);
        }
      }
      const search = untouched(share, () =>
        guard.inspectRead(
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: relative("projlink"), output_mode: "content" } },
          { cwd: share, searchWalkMaxMs: 10000 },
        ),
      );
      assert.equal(search.action, "block", `Grep ${relative("projlink")} in ${share}`);
    }
    // The MCP server judges a path from its own working folder.
    const before = process.cwd();
    process.chdir(`\\\\localhost\\${letter}$${rest}`);
    try {
      assert.equal(mcp.callTool("is_secret_file", { path: relative("notes.txt") }).is_secret_file, true);
    } finally {
      process.chdir(before);
    }
    // From a folder on that drive, it's a path in that folder, read as before.
    assert.equal(read("claude", `${letter}:notes.txt`, root), "allow");
    assert.equal(read("claude", `${letter}:kubelink\\config`, root), "block");
  },
);

test(
  "a bare drive letter named from a share as the working folder is stopped, and a word with a colon that names no path goes through",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const letter = root[0];
    const rest = root.slice(2);
    const untouched = watchLookups(t, (value) => /fileserver\.example|wsl\.localhost/i.test(value));
    const shares = [
      `\\\\localhost\\${letter}$${rest}`,
      "\\\\fileserver.example\\share\\proj",
      "\\\\wsl.localhost\\Ubuntu\\home\\me",
    ];
    for (const share of shares) {
      const shell = (command, toolName = "Bash") =>
        untouched(command, () =>
          guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: share } }, { cwd: share }),
        ).action;
      // `C:` alone is drive C's own working folder, which Guard can't see from a share.
      for (const drive of [`${letter}:`, `"${letter}:"`, `${letter.toLowerCase()}:`]) {
        for (const command of [`rg --hidden DB_ ${drive}`, `grep -r DB_ ${drive}`, `cat ${drive}`]) {
          assert.equal(shell(command), "block", `${command} in ${share}`);
        }
        assert.equal(shell(`Get-Content -LiteralPath ${drive}`, "PowerShell"), "block", share);
      }
      for (const [tool, event] of [
        ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: `${letter}:`, output_mode: "content" } }],
        ["gemini", { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: `${letter}:` } }],
        ["codex", { tool_name: "mcp__fs__search_files", tool_input: { pattern: "DB_", path: `${letter}:` } }],
        ["claude", { tool_name: "Read", tool_input: { file_path: `${letter}:` } }],
        ["gemini", { tool_name: "read_file", tool_input: { absolute_path: `${letter}:` } }],
      ]) {
        const outcome = untouched(`${tool} ${event.tool_name}`, () =>
          guard.inspectRead(tool, event, { cwd: share, searchWalkMaxMs: 10000 }),
        );
        assert.equal(outcome.action, "block", `${tool} ${event.tool_name} ${letter}: in ${share}`);
      }
      // A folder's stream type (`kubelink::$INDEX_ALLOCATION` opens the folder) or a space after the colon still names
      // a path on that drive.
      for (const file of [
        `${letter}:kubelink::$INDEX_ALLOCATION\\config`,
        `${letter}:kubelink:$I30:$INDEX_ALLOCATION\\config`,
        `${letter}: kubelink\\config`,
        `${letter}:proj::$INDEX_ALLOCATION\\notes.txt`,
      ]) {
        for (const tool of ["claude", "gemini", "codex"]) {
          const event =
            tool === "claude"
              ? { tool_name: "Read", tool_input: { file_path: file } }
              : tool === "gemini"
                ? { tool_name: "read_file", tool_input: { absolute_path: file } }
                : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
          assert.equal(
            untouched(file, () => guard.inspectRead(tool, event, { cwd: share })).action,
            "block",
            `${tool} ${file} in ${share}`,
          );
        }
        assert.equal(shell(`cat '${file.replace(/\\/g, "/")}'`), "block", `cat ${file} in ${share}`);
        assert.equal(shell(`Get-Content '${file}'`, "PowerShell"), "block", `Get-Content ${file} in ${share}`);
      }
      // A sed script, or a pattern with a colon and a space, names no drive.
      for (const command of ["sed s:a:b: notes.txt", "grep 'a: b' notes.txt", "sed -e 's:x:y:g' notes.txt"]) {
        assert.equal(shell(command), "allow", `${command} in ${share}`);
      }
    }
    const before = process.cwd();
    process.chdir(`\\\\localhost\\${letter}$${rest}`);
    try {
      assert.equal(mcp.callTool("is_secret_file", { path: `${letter}:` }).is_secret_file, true);
    } finally {
      process.chdir(before);
    }
  },
);

test(
  "a share on this computer written into a script's string, its backslashes doubled, is checked as the drive path",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const letter = root[0];
    const rest = root.slice(2);
    const doubled = (value) => value.replace(/\\/g, "\\\\");
    for (const share of [
      `\\\\localhost\\${letter}$${rest}`,
      `\\\\127.0.0.1\\${letter.toLowerCase()}$${rest}`,
      `\\\\${os.hostname()}\\${letter}$${rest}`,
    ]) {
      for (const toolName of ["Bash", "PowerShell"]) {
        const shell = (command) =>
          guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root })
            .action;
        for (const [tail, expected] of [
          ["kubelink\\config", "block"],
          ["notes.txt", "allow"],
        ]) {
          const inScript = doubled(`${share}\\${tail}`);
          for (const command of [
            `node -e "require('fs').readFileSync('${inScript}')"`,
            `python -c "print(open('${inScript}').read())"`,
          ]) {
            assert.equal(shell(command), expected, `${toolName} ${command}`);
          }
        }
      }
    }
  },
);

test(
  "a recursive read or search of a credentials folder on another computer is stopped by the folder's name",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const untouched = watchLookups(t, (value) => /fileserver\.example|wsl\.localhost/i.test(value));
    const homes = [
      "\\\\wsl.localhost\\Ubuntu\\home\\me",
      "\\\\fileserver.example\\share\\home",
      "//fileserver.example/share/home",
    ];
    const shell = (command, toolName = "Bash") =>
      untouched(command, () =>
        guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }),
      ).action;
    const search = (tool, folder) => {
      const event =
        tool === "claude"
          ? { tool_name: "Grep", tool_input: { pattern: "DB_", path: folder, output_mode: "content" } }
          : tool === "gemini"
            ? { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: folder } }
            : { tool_name: "mcp__fs__search_files", tool_input: { pattern: "DB_", path: folder } };
      return untouched(`${tool} ${folder}`, () =>
        guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }),
      );
    };
    for (const home of homes) {
      const sep = home.startsWith("//") ? "/" : "\\";
      for (const name of [
        ".kube",
        ".aws",
        ".ssh",
        ".docker",
        `.config${sep}gcloud`,
        ".KUBE",
        `.kube${sep}`,
        ".kube.",
      ]) {
        const folder = `${home}${sep}${name}`;
        for (const command of [`grep -r token '${folder}'`, `rg --hidden token '${folder}'`]) {
          assert.equal(shell(command), "block", command);
        }
        for (const tool of ["claude", "gemini", "codex"]) {
          assert.equal(search(tool, folder).action, "block", `${tool} ${folder}`);
        }
      }
      // The same folder reached by `..`, or named by a glob the shell expands.
      for (const folder of [`${home}${sep}.kube${sep}x${sep}..`, `${home}${sep}.ssh${sep}.${sep}x${sep}..`]) {
        assert.equal(shell(`grep -r token '${folder}'`), "block", folder);
        for (const tool of ["claude", "gemini", "codex"]) {
          assert.equal(search(tool, folder).action, "block", `${tool} ${folder}`);
        }
      }
      const slashed = home.replace(/\\/g, "/");
      assert.equal(shell(`rg --hidden token ${slashed}/.ku*`), "block", slashed);
      assert.equal(shell(`grep -r token ${slashed}/.ss?`), "block", slashed);
      // A glob before the folder, or dots after one, still comes to the folder once the shell expands it.
      for (const command of [
        `grep -r token ${slashed}/*/.kube`,
        `grep -r token ${slashed}/.ku*/.`,
        `grep -r token ${slashed}/.ku*/x/..`,
        `cp -r ${slashed}/*/.ssh x`,
      ]) {
        assert.equal(shell(command), "block", command);
      }
      // A recursive reader's own filter that names a credentials folder.
      for (const command of [
        `rg -g '.kube/*' token ${slashed}`,
        `rg -uuu -g '.kube/**' token ${slashed}`,
        `rg --hidden --iglob '.KUBE/*' token ${slashed}`,
        `rg --hidden -g 'Users/*/.ssh/*' token ${slashed}`,
      ]) {
        assert.equal(shell(command), "block", command);
      }
      const inHome = (command) =>
        untouched(command, () =>
          guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: home } }, { cwd: home }),
        ).action;
      for (const command of ["grep -r token */.kube", "grep -r token .ku*/.", "rg -g '.kube/*' token"]) {
        assert.equal(inHome(command), "block", `${command} in ${home}`);
      }
      assert.equal(inHome("rg -g '*.md' token"), "allow", `rg -g '*.md' in ${home}`);
      // From the folder itself, or one below it, as the working folder.
      for (const [cwd, folder] of [
        [`${home}${sep}.kube`, "."],
        [`${home}${sep}.kube`, `.${sep}`],
        [`${home}${sep}.config${sep}gcloud`, "."],
        [`${home}${sep}.ssh${sep}sub`, ".."],
      ]) {
        const inFolder = (command) =>
          untouched(command, () =>
            guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd } }, { cwd }),
          ).action;
        for (const command of [`rg --hidden token ${folder}`, `grep -r token ${folder}`]) {
          assert.equal(inFolder(command), "block", `${command} in ${cwd}`);
        }
        if (folder === ".") assert.equal(inFolder("rg --hidden token"), "block", `rg in ${cwd}`);
        for (const [tool, event] of [
          ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: folder, output_mode: "content" } }],
          ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", output_mode: "content" } }],
          ["gemini", { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: folder } }],
          ["codex", { tool_name: "mcp__fs__search_files", tool_input: { pattern: "DB_", path: folder } }],
        ]) {
          if (folder === ".." && !event.tool_input.path) continue;
          const outcome = untouched(`${tool} ${cwd}`, () =>
            guard.inspectRead(tool, event, { cwd, searchWalkMaxMs: 10000 }),
          );
          assert.equal(outcome.action, "block", `${tool} ${event.tool_input.path} in ${cwd}`);
        }
      }
      // A search's filter that names a credentials folder below the folder searched.
      for (const [tool, event] of [
        [
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: home, glob: ".kube/*", output_mode: "content" } },
        ],
        [
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: home, glob: "**/.kube/*", output_mode: "content" } },
        ],
        [
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: home, glob: ".ssh/*", output_mode: "content" } },
        ],
        [
          "gemini",
          { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: home, include_pattern: ".kube/**" } },
        ],
        ["gemini", { tool_name: "read_many_files", tool_input: { paths: [home], include: [".kube/**"] } }],
        // Below more folders, or anchored to the folder searched.
        ...["Users/alice/.ssh/*", "Users/*/.kube/*", "*/*/.kube/*", "Users/**/.kube/*", "/.kube/*"].flatMap((glob) => [
          ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: home, glob, output_mode: "content" } }],
          [
            "gemini",
            { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: home, include_pattern: glob } },
          ],
        ]),
        ["gemini", { tool_name: "read_many_files", tool_input: { paths: [home], include: ["Users/*/.kube/*"] } }],
      ]) {
        const outcome = untouched(`${tool} ${home}`, () =>
          guard.inspectRead(tool, event, { cwd: home, searchWalkMaxMs: 10000 }),
        );
        assert.equal(outcome.action, "block", `${tool} ${JSON.stringify(event.tool_input)}`);
      }
      // A path with dots in it is the file they come to, for the MCP tool too.
      assert.equal(
        mcp.callTool("is_secret_file", { path: `${home}${sep}.kube${sep}x${sep}..${sep}config` }).is_secret_file,
        true,
      );
      // A folder with any other name is judged by its name as before, and a search of it is noted.
      for (const name of ["proj", ".config", "kube"]) {
        const folder = `${home}${sep}${name}`;
        assert.equal(shell(`grep -r token '${folder}'`), "allow", folder);
        for (const tool of ["claude", "gemini", "codex"]) {
          assert.equal(search(tool, folder).action, "allow", `${tool} ${folder}`);
        }
      }
      // A filter any project uses (`*.json`, which a credentials store's name also matches) doesn't single one out.
      for (const glob of ["*.md", "**/*", "*/*", "*.json", "**/*.json", "*.yml", "*.xml", "*.db", "**/*.properties"]) {
        for (const [tool, event] of [
          ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: home, glob, output_mode: "content" } }],
          [
            "gemini",
            { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: home, include_pattern: glob } },
          ],
          ["gemini", { tool_name: "read_many_files", tool_input: { paths: [home], include: [glob] } }],
        ]) {
          const outcome = untouched(`${tool} ${glob}`, () =>
            guard.inspectRead(tool, event, { cwd: home, searchWalkMaxMs: 10000 }),
          );
          assert.equal(outcome.action, "allow", `${tool} ${glob} in ${home}`);
        }
      }
    }
    // A device path to another computer's credentials folder, whose `?` is no wildcard.
    for (const folder of [
      "\\\\?\\UNC\\fileserver.example\\share\\home\\.ssh",
      "\\\\?\\GLOBALROOT\\Device\\Mup\\fileserver.example\\share\\home\\.kube",
      "//?/UNC/fileserver.example/share/home/.kube",
      "\\\\?\\UNC\\fileserver.example\\share\\home\\.kube\\x\\..",
      "\\\\?\\UNC\\fileserver.example\\share\\home\\.config\\gcloud",
    ]) {
      for (const command of [`rg --hidden token '${folder}'`, `grep -r token '${folder}'`, `cp -r '${folder}' x`]) {
        assert.equal(shell(command), "block", command);
      }
    }
    assert.equal(
      mcp.callTool("is_secret_file", { path: "/net/fileserver.example/home/.kube/x/../config" }).is_secret_file,
      true,
    );
  },
);

test("a search filter anchored to the folder searched with a leading slash is read from that folder", (t) => {
  const root = fixture(t);
  for (const glob of ["/.e*", "/**/.env*", "/.kube/*", "/proj/.e*"]) {
    for (const [tool, event] of [
      ["claude", { tool_name: "Grep", tool_input: { pattern: "DB_", path: root, glob, output_mode: "content" } }],
      [
        "gemini",
        { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: root, include_pattern: glob } },
      ],
    ]) {
      const outcome = guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 });
      assert.equal(outcome.action, "block", `${tool} ${glob}`);
    }
  }
  const outcome = guard.inspectRead(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "DB_", path: root, glob: "/docs/*", output_mode: "content" } },
    { cwd: root, searchWalkMaxMs: 10000 },
  );
  assert.equal(outcome.action, "allow");
});

test("Claude Code's Grep reads a glob list split on spaces and commas, as Claude Code passes it to ripgrep", (t) => {
  const root = fixture(t);
  const grep = (glob) =>
    guard.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "DB_", path: root, glob, output_mode: "content" } },
      { cwd: root, searchWalkMaxMs: 10000 },
    ).action;
  for (const glob of ["*.md,.env", "*.md .env", "*.md,.e*", "*.md,.kube/*", "*.md, proj/.e*"]) {
    assert.equal(grep(glob), "block", glob);
  }
  for (const glob of ["*.md,*.txt", "*.{md,txt}", "docs/*"]) assert.equal(grep(glob), "allow", glob);
});

test("findstr's quoted /d: folder list is read without its quotes", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  // From a folder with no secret file in it, so only the folders given are read.
  const cwd = path.join(root, "docs");
  const shell = (command, toolName) =>
    (toolName
      ? guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd } }, { cwd })
      : guard.inspectShell("cursor", { command, cwd }, { cwd })
    ).action;
  for (const toolName of ["PowerShell", null]) {
    for (const command of [
      `findstr /s /d:"${root}\\.kube" token *`,
      `findstr /s /d:"..\\.kube" token *`,
      `findstr /s /d:"..\\docs,..\\.kube" token *`,
      `findstr /s /d:"..\\docs","..\\.kube" token *`,
    ]) {
      assert.equal(shell(command, toolName), "block", `${toolName} ${command}`);
    }
    assert.equal(shell(`findstr /s /d:"${root}\\docs" token *`, toolName), "allow", `${toolName} docs`);
  }
});

test(
  "a filter or glob on another computer naming any SSH key or credential store is stopped by its name",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const untouched = watchLookups(t, (value) => /fileserver\.example|wsl\.localhost/i.test(value));
    const home = "\\\\fileserver.example\\share\\home";
    const wsl = "\\\\wsl.localhost\\Ubuntu\\home\\me";
    const shell = (command, cwd = root, toolName = "Bash") =>
      untouched(command, () =>
        guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd } }, { cwd }),
      ).action;
    const search = (tool, args, cwd = root) => {
      const event =
        tool === "claude"
          ? { tool_name: "Grep", tool_input: { pattern: "DB_", output_mode: "content", ...args } }
          : tool === "gemini"
            ? { tool_name: "search_file_content", tool_input: { pattern: "DB_", ...args } }
            : { tool_name: "read_many_files", tool_input: args };
      return untouched(`${tool} ${JSON.stringify(args)}`, () =>
        guard.inspectRead(tool === "many" ? "gemini" : tool, event, { cwd, searchWalkMaxMs: 10000 }),
      ).action;
    };
    // A filter for any key or store in a credentials folder, not only the first one Guard thought of.
    for (const glob of [
      ".ssh/id_e*",
      ".ssh/id_ed*",
      ".ssh/*25519",
      ".ssh/id_[de]*",
      "Users/*/.ssh/id_e*",
      ".config/gcloud/access*",
    ]) {
      assert.equal(search("claude", { path: home, glob }), "block", `Grep ${glob}`);
      assert.equal(search("gemini", { path: home, include_pattern: glob }), "block", `Gemini ${glob}`);
      assert.equal(search("many", { paths: ["."], include: [glob] }, home), "block", `read_many_files ${glob}`);
      assert.equal(search("claude", { glob }, wsl), "block", `Grep ${glob} in ${wsl}`);
      assert.equal(shell(`rg --hidden -g '${glob}' DB_ //fileserver.example/share/home`), "block", `rg -g ${glob}`);
    }
    // A glob that could match a key other than id_rsa.
    for (const [command, cwd, toolName] of [
      ["cat .ssh/id_e*", wsl],
      ["cat //fileserver.example/share/home/.ssh/id_ed*", root],
      [`Get-Content ${wsl}\\.ssh\\*25519`, root, "PowerShell"],
      ["cat .ssh/id_ec*", wsl],
    ]) {
      assert.equal(shell(command, cwd, toolName), "block", `${command} in ${cwd}`);
    }
    assert.equal(search("many", { paths: ["."], include: ["**/id_e*"] }, wsl), "block", "read_many_files id_e*");
    // A recursive reader's filter with no wildcard, or one naming a secret file, on a folder there.
    for (const [command, cwd] of [
      ["rg --hidden --glob=.kube/config DB_ //fileserver.example/share/home", root],
      ["rg --hidden -g.docker/config.json DB_ //fileserver.example/share/home", root],
      ["rg -uu --iglob=.aws/credentials DB_ //fileserver.example/share/home", root],
      ["rg --hidden --glob=.ssh/id_ed25519 DB_ //fileserver.example/share/home", root],
      ["rg --hidden --glob=.env DB_ //fileserver.example/share/proj", root],
      ["rg --hidden --glob=**/.env DB_ //fileserver.example/share/proj", root],
      ["grep -r --include=.env DB_ //fileserver.example/share/proj", root],
      ["grep -r --include=*.pem DB_ //fileserver.example/share/proj", root],
      ["rg --hidden --glob=.kube/config DB_", wsl],
      ["rg --hidden --glob=.kube/config DB_", home],
    ]) {
      assert.equal(shell(command, cwd), "block", `${command} in ${cwd}`);
    }
    // A credentials folder whose last part Windows drops (`.kube\ `, `.kube\...`).
    for (const folder of [
      `${home}\\.kube\\ `,
      `${home}\\.kube\\...`,
      `${home}\\.kube\\. `,
      `${home}\\.kube\\x\\..\\ `,
    ]) {
      assert.equal(shell(`grep -r token '${folder}'`), "block", folder);
      assert.equal(search("claude", { path: folder }), "block", `Grep ${folder}`);
    }
    // Ordinary filters and globs in a project there still go through.
    const proj = `${wsl}\\proj`;
    for (const command of [
      "rg --hidden --glob=*.md DB_ //fileserver.example/share/proj",
      "grep -rn handler src/ge*",
      "rg TODO packages/gc*",
      "grep -r TODO *h",
      "grep -r TODO src/gh*",
    ]) {
      assert.equal(shell(command, proj), "allow", `${command} in ${proj}`);
    }
  },
);

test(
  "a search filter on another computer is read as ripgrep reads it: a wildcard reaches a dot folder, and a folder before a secret name doesn't hide it",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const untouched = watchLookups(t, (value) => /fileserver\.example|wsl\.localhost/i.test(value));
    const home = "\\\\fileserver.example\\home\\alex";
    const proj = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const search = (tool, location, glob) => {
      const event =
        tool === "claude"
          ? { tool_name: "Grep", tool_input: { pattern: "DB_", path: location, glob, output_mode: "content" } }
          : { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: location, include_pattern: glob } };
      return untouched(`${tool} ${glob}`, () => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }))
        .action;
    };
    const shell = (command) =>
      untouched(command, () =>
        guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }),
      ).action;
    for (const [location, glob] of [
      [home, "?ssh/id_*"],
      [home, "[.]ssh/*"],
      [home, "*ssh/*"],
      [home, "**/[.]ssh/**"],
      [home, "Users/*/?ssh/*"],
      [home, ".conf*/g?/*"],
      [proj, "proj/.env*"],
      [proj, "app/.e*"],
      [proj, "src/**/.env*"],
      [proj, "deploy/id_*"],
    ]) {
      assert.equal(search("claude", location, glob), "block", `Grep ${glob}`);
      assert.equal(search("gemini", location, glob), "block", `Gemini ${glob}`);
    }
    assert.equal(search("claude", home, "*.md,?ssh/*"), "block", "Grep *.md,?ssh/*");
    for (const command of [
      "rg --hidden --glob='?ssh/id_*' PRIVATE //fileserver.example/home/alex",
      "rg --hidden --iglob='?SSH/*' PRIVATE //fileserver.example/home/alex",
      "rg --hidden -g'*ssh/*' PRIVATE //fileserver.example/home/alex",
      "rg --hidden -g'keys/id_*' PRIVATE //fileserver.example/home/alex",
    ]) {
      assert.equal(shell(command), "block", command);
    }
    // A filter that matches a file of that name in any folder, or any file of that type, is only noted.
    for (const glob of [
      "*/config",
      "config",
      "config*",
      "config.*",
      "**/config.*",
      "settings.*",
      "**/settings.*",
      "auth.*",
      "hosts.*",
      "gradle.*",
      "access*",
      "application_*",
      "msal*",
      "oauth*",
      "src/**/*.md",
      "proj/*.json",
      "*/*",
    ]) {
      assert.equal(search("claude", proj, glob), "allow", `Grep ${glob}`);
      assert.equal(search("gemini", proj, glob), "allow", `Gemini ${glob}`);
    }
  },
);

test("a long Claude Code Grep glob list is checked inside the hook's deadline", (t) => {
  const root = fixture(t);
  const grep = (glob, options = {}) => {
    const started = Date.now();
    const outcome = guard.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "DB_", path: root, glob, output_mode: "content" } },
      { cwd: root, startedAt: started, ...options },
    );
    return { action: outcome.action, elapsed: Date.now() - started };
  };
  // The same glob many times over is one glob.
  let outcome = grep(`${Array(120_000).fill(".").join(",")},.env`);
  assert.equal(outcome.action, "block");
  assert.ok(outcome.elapsed < 2500, `repeated globs took ${outcome.elapsed} ms`);
  // An unclosed brace in a long piece is read in linear time.
  outcome = grep(`${"{".repeat(100_000)},.env`);
  assert.equal(outcome.action, "block");
  assert.ok(outcome.elapsed < 2500, `an unclosed brace took ${outcome.elapsed} ms`);
  // Many different globs stop at the deadline, and the search is stopped as one that didn't finish.
  const many = Array.from({ length: 120_000 }, (_, index) => `n${index}.txt`).join(",");
  outcome = grep(`${many},.env`, { hookCheckMaxMs: 1000 });
  assert.equal(outcome.action, "block");
  assert.ok(outcome.elapsed < 3000, `many globs took ${outcome.elapsed} ms`);
});

test("GNU grep's long options are read when shortened, as grep reads them", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const untouched = watchLookups(t, (value) => /fileserver\.example/i.test(value));
  const shell = (command, tool = "claude") =>
    untouched(command, () =>
      tool === "claude"
        ? guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root })
        : guard.inspectShell("cursor", { command, cwd: root }, { cwd: root }),
    ).action;
  for (const tool of ["claude", "cursor"]) {
    for (const command of [
      "grep --rec DB_ proj",
      "grep --recursi DB_ proj",
      "grep --di=recurse DB_ proj",
      "grep --dir recurse DB_ proj",
      "grep --dereference-r DB_ proj",
      "grep -r --inc=id_* DB_ //fileserver.example/home/alex",
      "grep -r --incl .env DB_ //fileserver.example/share/proj",
    ]) {
      assert.equal(shell(command, tool), "block", `${tool} ${command}`);
    }
    for (const command of ["grep --col=auto DB_ notes.txt", "grep --rec --inc=*.md DB_ docs"]) {
      assert.equal(shell(command, tool), "allow", `${tool} ${command}`);
    }
  }
});

test("rg's own file types are read as its filters", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const untouched = watchLookups(t, (value) => /fileserver\.example/i.test(value));
  const shell = (command) =>
    untouched(command, () =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }),
    ).action;
  for (const command of [
    "rg --hidden --type-add k:id_* -tk DB_ //fileserver.example/home/alex",
    "rg --hidden --type-add=k:.env* --type=k DB_ //fileserver.example/share/proj",
    "rg --hidden --type-add 'k:*.md' --type-add 'k:.env' -t k DB_ //fileserver.example/share/proj",
  ]) {
    assert.equal(shell(command), "block", command);
  }
  for (const command of [
    "rg -tpy DB_ //fileserver.example/share/proj",
    "rg --type-add k:*.md -tk DB_ //fileserver.example/share/proj",
    "rg --type-add k:*.txt -tpy DB_ //fileserver.example/share/proj",
  ]) {
    assert.equal(shell(command), "allow", command);
  }
});

test(
  "is_secret_file judges a path written with a trailing separator as the file it opens",
  { skip: WINDOWS_ONLY },
  () => {
    for (const file of [
      "\\\\fileserver.example\\home\\alex\\.kube\\config\\",
      "//fileserver.example/home/alex/.kube/config/",
      "\\\\?\\UNC\\fileserver.example\\home\\alex\\.kube\\config\\",
      ".docker\\config.json\\",
      ".docker/config.json//",
    ]) {
      assert.equal(mcp.callTool("is_secret_file", { path: file }).is_secret_file, true, file);
    }
    assert.equal(
      mcp.callTool("is_secret_file", { path: "\\\\fileserver.example\\home\\alex\\" }).is_secret_file,
      false,
    );
  },
);

test(
  "dots that could take a device path from another computer to this one's drive leave a read noted",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const rest = root.slice(2);
    fs.writeFileSync(path.join(root, "aws.txt"), `aws_access_key_id = ${["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("")}\n`);
    const climbs = [
      `\\\\?\\UNC\\fileserver.example\\share\\..\\..\\..\\${root}`,
      `\\??\\UNC\\fileserver.example\\share\\..\\..\\..\\${root}`,
      ...volumeNames(root)
        .filter((volume) => volume.startsWith("\\\\?\\"))
        .map((volume) => `\\\\?\\UNC\\fileserver.example\\share\\..\\..\\..\\${volume.slice(4)}${rest}`),
    ];
    for (const climb of climbs) {
      for (const tool of ["claude", "gemini", "codex"]) {
        const event = (file) =>
          tool === "claude"
            ? { tool_name: "Read", tool_input: { file_path: file } }
            : tool === "gemini"
              ? { tool_name: "read_file", tool_input: { absolute_path: file } }
              : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
        assert.deepEqual(
          guard.inspectRead(tool, event(`${climb}\\notes.txt`), { cwd: root }),
          { action: "allow", internalError: true },
          `${tool} ${climb}\\notes.txt`,
        );
        // Its name, and a link behind it, are still judged on this computer's drive.
        assert.equal(guard.inspectRead(tool, event(`${climb}\\kubelink\\config`), { cwd: root }).action, "block");
      }
      assert.deepEqual(
        guard.inspectRead(
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "zzz", path: `${climb}\\docs`, output_mode: "content" } },
          { cwd: root, searchWalkMaxMs: 10000 },
        ),
        { action: "allow", searchLimited: true },
        climb,
      );
    }
    // Dots that stay below the drive open that file, or nothing, however they're read.
    const read = (file) =>
      guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root });
    assert.equal(read(`\\\\?\\${root}\\docs\\..\\aws.txt`).action, "block");
    const below = read(`\\\\?\\${root}\\docs\\..\\notes.txt`);
    assert.equal(below.action, "allow");
    assert.ok(!below.internalError);
  },
);

test("a read under two names keeps what either read found below the stop level", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "contact.txt"), "contact jane.doe@example.com\n");
  fs.writeFileSync(`\\\\?\\${root}\\contact.txt.`, "plain\n");
  const read = (file) =>
    guard.inspectRead(
      "claude",
      { tool_name: "Read", tool_input: { file_path: file } },
      { cwd: root, includePersonalDetails: true },
    );
  const direct = read(path.join(root, "contact.txt"));
  if (!direct.belowMinimumOnly && !direct.reported) {
    t.diagnostic("the engine reported nothing for an email address, so there is no note to keep");
    return;
  }
  for (const file of [`\\\\.\\${root}\\contact.txt.`, `${root}\\contact.txt.`]) {
    const outcome = read(file);
    assert.equal(outcome.action, "allow", file);
    assert.equal(Boolean(outcome.belowMinimumOnly), Boolean(direct.belowMinimumOnly), file);
    assert.equal(Boolean(outcome.reported?.length), Boolean(direct.reported?.length), file);
  }
});

test(
  "a device path through a name Guard can't place is stopped, without looking it up",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const checks = pathChecks(root);
    const rest = root.slice(2);
    // A logon session's own DOS devices, and its link back to the global ones, are the same drive paths.
    const session = "\\\\.\\GLOBALROOT\\Sessions\\0\\DosDevices\\00000000-00c10712";
    expectAll(
      checks,
      [`${session}\\Global\\${root}\\kubelink\\config`, `${session}\\${root}\\kubelink\\config`],
      "block",
    );
    expectAll(checks, [`${session}\\Global\\${root}\\notes.txt`], "allow");
    // A name in the system's namespace that isn't a drive, a share, a volume's own name or a device that's no file: a
    // volume's interface name, a link a program made under the session's objects, a DOS device a program defined, or
    // another driver's device. Any of them can open a folder on this computer, so a path through one could be any file,
    // and some could reach another computer, so none is looked up.
    const unknown = [
      `\\\\.\\STORAGE#Volume#{11111111-2222-3333-4444-555555555555}#0000000000100000#{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}${rest}`,
      `\\\\.\\GLOBALROOT\\Sessions\\1\\BaseNamedObjects\\clotrlink${rest}`,
      `\\\\.\\ClotrDevice${rest}`,
      `\\\\?\\Global\\ClotrDevice${rest}`,
      `\\\\.\\GLOBALROOT\\Device\\ClotrDriver${rest}`,
      `\\\\.\\GLOBALROOT\\Device\\HarddiskVolume3\\..\\ClotrDriver${rest}`,
      // A port's or a disk's name with a folder below it is no port or disk: a program defined it.
      `\\\\.\\COM97${rest}`,
      `\\\\.\\LPT97${rest}`,
      `\\\\.\\PhysicalDrive97${rest}`,
      `\\\\.\\NUL${rest}`,
      `\\\\.\\GLOBALROOT\\Device\\Null${rest}`,
    ];
    const untouched = watchLookups(t, (value) =>
      /ClotrDevice|ClotrDriver|clotrlink|STORAGE#Volume|COM97|LPT97|PhysicalDrive97|[\\/]NUL[\\/]|[\\/]Null[\\/]/i.test(
        value,
      ),
    );
    for (const device of unknown) {
      for (const [name, run] of Object.entries(checks)) {
        for (const file of [`${device}\\kubelink\\config`, `${device}\\notes.txt`]) {
          assert.equal(
            untouched(file, () => run(file)),
            "block",
            `${name} ${file}`,
          );
        }
      }
      const shell = (command, toolName = "PowerShell") =>
        untouched(command, () =>
          guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }),
        ).action;
      assert.equal(shell(`grep -r DB_ '${device}\\projlink'`), "block", device);
      assert.equal(shell(`findstr /s DB_ '${device}\\projlink\\*'`), "block", device);
      const search = untouched(device, () =>
        guard.inspectRead(
          "claude",
          { tool_name: "Grep", tool_input: { pattern: "DB_", path: `${device}\\projlink`, output_mode: "content" } },
          { cwd: root, searchWalkMaxMs: 10000 },
        ),
      );
      assert.equal(search.action, "block", device);
    }
    // A device that's no file, and another computer's share by a redirector's name, are judged by name as before.
    const shell = (command) =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }).action;
    assert.equal(shell("cat //./pipe/clotr-test"), "allow");
    assert.equal(shell("cat //./NUL"), "allow");
    assert.equal(shell("cat //./COM3"), "allow");
    assert.equal(shell("cat //./Tape0"), "allow");
    // A shell word cut short by a quoted `(` or `;` (a separate gap in reading a command) ends at a volume's ARC name
    // or a redirector with nothing below it, which names nothing Guard can place, so it's stopped too.
    const quoted = (command, toolName) =>
      guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
    assert.equal(
      quoted(
        `cmd /c type "\\\\.\\GLOBALROOT\\ArcName\\multi(0)disk(0)rdisk(0)partition(3)${rest}\\notes.txt"`,
        "PowerShell",
      ),
      "block",
    );
    assert.equal(
      quoted(
        `Get-Content "\\\\?\\GLOBALROOT\\Device\\Mup\\;LanmanRedirector\\localhost\\C$${rest}\\notes.txt"`,
        "PowerShell",
      ),
      "block",
    );
    assert.equal(
      quoted(
        `cat "//?/GLOBALROOT/Device/Mup/;LanmanRedirector/localhost/C$${rest.replace(/\\/g, "/")}/notes.txt"`,
        "Bash",
      ),
      "block",
    );
    for (const file of [
      "\\\\.\\pipe\\clotr-test",
      "\\\\.\\GLOBALROOT\\Device\\WebDavRedirector\\fileserver.example\\share\\notes.txt",
      "\\\\.\\GLOBALROOT\\Device\\RdpDr\\;:1\\tsclient\\C\\notes.txt",
      "\\\\.\\UNC\\fileserver.example\\share\\notes.txt",
    ]) {
      assert.equal(guard.isSecretPath(file), false, file);
      assert.equal(
        guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd: root }).action,
        "allow",
        file,
      );
    }
  },
);

test(
  "a drive's share or volume named in the other ways Windows reads it is checked as the drive path",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const checks = pathChecks(root);
    const letter = root[0];
    const rest = root.slice(2);
    const shares = [
      // An IPv6 address unbracketed, as a device path's UNC part takes it.
      `\\\\.\\UNC\\::1\\${letter}$${rest}`,
      `\\\\?\\UNC\\0:0:0:0:0:0:0:1\\${letter}$${rest}`,
      // The SMB redirector's own device, and Mup with a provider part before the host.
      `\\\\.\\GLOBALROOT\\Device\\LanmanRedirector\\localhost\\${letter}$${rest}`,
    ];
    // With a provider part: a `;` in a quoted shell word is a separate gap in reading the command (a quoted `a;b/.env`
    // isn't seen as one path either), so these are tried outside a shell.
    const providers = [
      `\\\\?\\GLOBALROOT\\Device\\LanmanRedirector\\;${letter}:0000000000012345\\localhost\\${letter}$${rest}`,
      `\\\\.\\GLOBALROOT\\Device\\Mup\\;LanmanRedirector\\localhost\\${letter}$${rest}`,
    ];
    const volumes = volumeNames(root);
    if (volumes.length < 3) t.diagnostic(`only ${volumes.length} of the drive's volume names were found`);
    const all = [...shares, ...volumes.map((volume) => `${volume}${rest}`)];
    expectAll(
      checks,
      all.map((share) => `${share}\\kubelink\\config`),
      "block",
    );
    const outsideShell = Object.fromEntries(
      Object.entries(checks).filter(([name]) => /Read|read|MCP/.test(name) && !/Bash|PowerShell|cmd|shell/.test(name)),
    );
    expectAll(
      outsideShell,
      providers.map((share) => `${share}\\kubelink\\config`),
      "block",
    );
    expectAll(
      outsideShell,
      providers.map((share) => `${share}\\notes.txt`),
      "allow",
    );
    for (const share of [...all, ...providers]) {
      assert.equal(guard.isSecretPath(`${share}\\kubelink\\config`), true, share);
      assert.equal(guard.isSecretPath(`${share}\\.kube\\config`), true, share);
    }
    expectAll(
      checks,
      all.map((share) => `${share}\\notes.txt`),
      "allow",
    );
  },
);

// Records each lookup whose path `matches`, until the test ends.
function watchLookups(t, matches) {
  const touched = [];
  const watched = ["lstatSync", "statSync", "realpathSync", "openSync", "opendirSync", "readdirSync", "existsSync"];
  const originals = {};
  const native = fs.realpathSync.native;
  for (const name of watched) {
    originals[name] = fs[name];
    fs[name] = function (...args) {
      if (typeof args[0] === "string" && matches(args[0])) touched.push(`${name} ${args[0]}`);
      return originals[name].apply(this, args);
    };
  }
  fs.realpathSync.native = function (...args) {
    if (typeof args[0] === "string" && matches(args[0])) touched.push(`realpathSync.native ${args[0]}`);
    return native.apply(this, args);
  };
  t.after(() => {
    for (const name of watched) fs[name] = originals[name];
    fs.realpathSync.native = native;
  });
  return (label, run) => {
    touched.length = 0;
    const result = run();
    assert.deepEqual(touched, [], `${label} looked a path up`);
    return result;
  };
}

test("a share on another computer is judged by name, however it's reached or named", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const letter = root[0];
  const rest = root.slice(2);
  let drivesWatched = true;
  const untouched = watchLookups(t, (value) => (drivesWatched && value.includes(rest)) || /fileserver/i.test(value));
  const read = (file, cwd) =>
    guard.inspectRead("claude", { tool_name: "Read", tool_input: { file_path: file } }, { cwd }).action;
  // A name that starts with this computer's but goes on (`<this computer>.attacker.example`) is another computer's.
  // `\\?\` and `\??\` may pass `..` on as a name, so going back up from another's share may open that computer's file:
  // that share is never looked up, and a read isn't checked from this computer's drive (the drive is looked up for a
  // link, in case the dots are resolved; see "a share path with dots below the share").
  const climbing = (share) => /fileserver/.test(share);
  const watched = (label, run) => {
    drivesWatched = false;
    try {
      return untouched(label, run);
    } finally {
      drivesWatched = true;
    }
  };
  for (const share of [
    `\\\\${os.hostname()}.attacker.example\\${letter}$${rest}`,
    `\\\\?\\UNC\\fileserver.example\\x\\..\\..\\localhost\\${letter}$${rest}`,
    `\\??\\UNC\\fileserver.example\\x\\..\\..\\localhost\\${letter}$${rest}`,
  ]) {
    if (climbing(share)) {
      assert.equal(
        watched(share, () => guard.isSecretPath(`${share}\\kubelink\\config`)),
        true,
        share,
      );
      assert.equal(
        watched(share, () => guard.isSecretPath(`${share}\\.kube\\config`)),
        true,
        share,
      );
      assert.deepEqual(
        watched(share, () =>
          guard.inspectRead(
            "claude",
            { tool_name: "Read", tool_input: { file_path: `${share}\\notes.txt` } },
            { cwd: root },
          ),
        ),
        { action: "allow", internalError: true },
        share,
      );
      continue;
    }
    assert.equal(
      untouched(share, () => guard.isSecretPath(`${share}\\kubelink\\config`)),
      false,
      share,
    );
    assert.equal(
      untouched(share, () => guard.isSecretPath(`${share}\\.kube\\config`)),
      true,
      share,
    );
    // A read isn't let through or opened: the share is never read, only judged (a `?` here also reads as a wildcard
    // that could match `config`, which holds `kubelink\config`, so an ordinary name is read).
    assert.deepEqual(
      untouched(share, () =>
        guard.inspectRead(
          "claude",
          { tool_name: "Read", tool_input: { file_path: `${share}\\notes.txt` } },
          { cwd: root },
        ),
      ),
      { action: "allow", internalError: true },
      share,
    );
  }
  const lookalike = `\\\\${os.hostname()}.attacker.example\\${letter}$${rest}\\kubelink\\config`;
  assert.equal(
    untouched(lookalike, () => read(lookalike, root)),
    "allow",
  );
  // A relative path written with a last dot, in a folder on another computer's share named as a device path, is
  // judged by name: neither the share nor this computer's drive is asked.
  const cwd = "\\??\\UNC\\fileserver.example\\share\\proj";
  const shell = (command, toolName) =>
    untouched(command, () =>
      guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd } }, { cwd }),
    ).action;
  for (const file of ["kubelink.\\config", "kubelink\\config.", "docs.\\readme.md"]) {
    assert.equal(
      untouched(file, () => guard.isSecretPath(file, "", cwd)),
      false,
      file,
    );
    assert.equal(
      untouched(file, () => read(file, cwd)),
      "allow",
      file,
    );
    assert.equal(shell(`cat '${file.replace(/\\/g, "/")}'`, "Bash"), "allow", file);
    assert.equal(shell(`Get-Content -LiteralPath '${file}'`, "PowerShell"), "allow", file);
  }
  for (const file of [".kube.\\config", ".kube\\config.", ".env."]) {
    assert.equal(
      untouched(file, () => guard.isSecretPath(file, "", cwd)),
      true,
      file,
    );
    assert.equal(shell(`cat '${file.replace(/\\/g, "/")}'`, "Bash"), "block", file);
  }
});

// A folder's listing answers for a name only when no short name could stand for another file: any 8.3 name can be one
// (an administrator can give `CONFIG.TXT` to any file), so it's looked up, whatever the listing holds.
test(
  "a name that could be a short name is looked up, not answered from its folder's listing",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const looked = [];
    const { lstatSync } = fs;
    fs.lstatSync = function (...args) {
      if (typeof args[0] === "string" && args[0].startsWith(root)) looked.push(path.basename(args[0]));
      return lstatSync.apply(this, args);
    };
    t.after(() => {
      fs.lstatSync = lstatSync;
    });
    const shell = (command) =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }).action;
    for (const name of ["CONFIG.TXT", "KUBE", "a.b", "Z_1.B"]) {
      looked.length = 0;
      assert.equal(shell(`cat '${name}'`), "allow", name);
      assert.ok(looked.includes(name), `${name} was answered from the listing`);
    }
    // A name no short name can be is answered from the listing, which the check reads once.
    looked.length = 0;
    assert.equal(shell("cat no-such-long-name.text 'long-trailing-name.' 'with long space '"), "allow");
    assert.deepEqual(
      looked.filter((name) => /no-such|trailing|long space/.test(name)),
      [],
    );
  },
);

// A command padded with paths that each have another drive path to check (a last dot, or a folder on this computer's
// drive share) stops by a set time, so the hook still answers in time: a cutoff of 0 shows where it stops.
test("a command padded with tidied or share paths stops at its own cutoff", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const share = `\\\\localhost\\${root[0]}$${root.slice(2)}`;
  const shell = (command, cwd, options = {}) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd } }, { cwd, ...options });
  const now = { shellDrivePathMaxMs: 0 };
  // On the drive, only an operand with a tidied reading stops; a secret file's own name is still named.
  assert.equal(shell("cat notes.txt.", root, now).location, "too many paths to check");
  assert.equal(shell("cat notes.txt.", root).action, "allow");
  assert.equal(shell("cat notes.txt", root, now).action, "allow");
  assert.equal(shell("cat .env.", root, now).location, ".env.");
  assert.equal(shell("grep -r DB_ docs.", root, now).location, "too many paths to check");
  // On this computer's drive share, every operand has its drive path.
  assert.equal(shell("cat notes.txt", share, now).location, "too many paths to check");
  assert.equal(shell("cat notes.txt", share).action, "allow");
  assert.equal(shell("cat .env", share, now).location, ".env");
  // A caller giving the operands more time gives these the same (see shellWalkBudget).
  assert.equal(shell("cat notes.txt.", root, { shellOperandMaxMs: 600_000 }).action, "allow");
});

test(
  "a 300,000-character command padded with tidied or share paths is checked quickly",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const share = `\\\\localhost\\${root[0]}$${root.slice(2)}`;
    for (const [cwd, suffix] of [
      [root, "."],
      [root, " "],
      [share, ""],
      [share, "."],
    ]) {
      const operands = [];
      for (let index = 0, length = 0; length < 300_000; index += 1) {
        const operand = `'${index.toString(36)}${suffix}'`;
        operands.push(operand);
        length += operand.length + 1;
      }
      const padding = operands.join(" ");
      for (const command of [`cat ${padding}`, `grep -r DB_ ${padding}`, `rg DB_ ${padding}`, `cat ${padding} .env`]) {
        const label = `${JSON.stringify(command.slice(0, 16))} in ${cwd === root ? "the folder" : "its share"} with ${JSON.stringify(suffix)}`;
        const started = Date.now();
        const outcome = guard.inspectShell(
          "claude",
          { tool_name: "Bash", tool_input: { command, cwd } },
          { cwd, startedAt: started },
        );
        const elapsed = Date.now() - started;
        assert.ok(!outcome.internalError, label);
        if (command.endsWith(".env")) assert.equal(outcome.action, "block", label);
        else if (outcome.action === "block") assert.equal(outcome.location, "too many paths to check", label);
        assert.ok(elapsed < 2500, `${label} took ${elapsed} ms`);
      }
    }
  },
);

test("a Read file_path too long for the system to open is judged by name, without the disk, and quickly", (t) => {
  const root = fixture(t);
  const limit = process.platform === "win32" ? 32767 : 4096;
  const lookedUp = [];
  const watched = ["lstatSync", "statSync", "realpathSync", "openSync"];
  const originals = {};
  const native = fs.realpathSync.native;
  for (const name of watched) {
    originals[name] = fs[name];
    fs[name] = function (...args) {
      if (typeof args[0] === "string" && args[0].length > limit) lookedUp.push(name);
      return originals[name].apply(this, args);
    };
  }
  fs.realpathSync.native = function (...args) {
    if (typeof args[0] === "string" && args[0].length > limit) lookedUp.push("realpathSync.native");
    return native.apply(this, args);
  };
  t.after(() => {
    for (const name of watched) fs[name] = originals[name];
    fs.realpathSync.native = native;
  });
  const sep = path.sep;
  const long = `${"x".repeat(300_000)}${sep}`;
  const read = (tool, file) => {
    const event =
      tool === "claude"
        ? { tool_name: "Read", tool_input: { file_path: file } }
        : tool === "cursor"
          ? { file_path: file, content: "notes\n" }
          : tool === "gemini"
            ? { tool_name: "read_file", tool_input: { absolute_path: file } }
            : { tool_name: "mcp__fs__read_file", tool_input: { path: file } };
    const started = Date.now();
    const outcome = guard.inspectRead(tool, event, { cwd: root, startedAt: started });
    assert.ok(Date.now() - started < 2500, `${tool} took ${Date.now() - started} ms`);
    return outcome;
  };
  for (const tool of ["claude", "cursor", "gemini", "codex"]) {
    lookedUp.length = 0;
    assert.equal(read(tool, `${long}notes.txt`).action, "allow", tool);
    assert.equal(read(tool, `${long}.env`).action, "block", tool);
    assert.equal(read(tool, path.join(root, `${long}kubelink`, "config")).action, "allow", tool);
    assert.deepEqual(lookedUp, [], `${tool} looked up a path too long to open`);
    // A long path that comes down to a short one is opened by Node all the same, so it gets the full check.
    const padded = `${`x${sep}..${sep}`.repeat(50_000)}`;
    assert.equal(read(tool, `${padded}.env`).action, "block", tool);
    assert.equal(read(tool, `${padded}notes.txt`).action, "allow", tool);
  }
});

test("grep's -d and --directories value is read when shortened, as grep reads it", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const shell = (command, tool) =>
    (tool === "claude"
      ? guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root })
      : guard.inspectShell("cursor", { command, cwd: root }, { cwd: root })
    ).action;
  for (const tool of ["claude", "cursor"]) {
    for (const command of [
      "grep -d rec DB_ proj",
      "grep -drec DB_ proj",
      "grep --directories=recu DB_ proj",
      "grep --di=rec DB_ proj",
      "grep -d recurse DB_ proj",
    ]) {
      assert.equal(shell(command, tool), "block", `${tool} ${command}`);
    }
    for (const command of ["grep -d rea DB_ proj", "grep -d skip DB_ proj", "grep -d re DB_ proj"]) {
      assert.equal(shell(command, tool), "allow", `${tool} ${command}`);
    }
  }
});

test(
  "a filter on another computer naming a secret file below a wildcard folder is stopped, and one matching ordinary folders is not",
  { skip: WINDOWS_ONLY },
  (t) => {
    const root = fixture(t);
    const untouched = watchLookups(t, (value) => /fileserver\.example|wsl\.localhost/i.test(value));
    const home = "\\\\fileserver.example\\home\\alex";
    const proj = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const search = (tool, location, glob) => {
      const event =
        tool === "claude"
          ? { tool_name: "Grep", tool_input: { pattern: "DB_", path: location, glob, output_mode: "content" } }
          : { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: location, include_pattern: glob } };
      return untouched(`${tool} ${glob}`, () => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }))
        .action;
    };
    // A wildcard folder that ends like an ordinary one's name still reaches `.kube`, `.m2` or `.gradle`.
    for (const glob of [
      "*e/config",
      "**/*e/config",
      "*e*/config",
      "*e/conf*",
      "*e/gradle.properties",
      "*s/credentials",
    ]) {
      assert.equal(search("claude", home, glob), "block", `Grep ${glob}`);
      assert.equal(search("gemini", home, glob), "block", `Gemini ${glob}`);
    }
    // A wildcard folder that matches common project folders isn't read as a credentials folder.
    for (const glob of ["src/*s/*.ts", "*er/*.ts", "????/*", "*[!e]/*.md", "*s/*", "*/config"]) {
      assert.equal(search("claude", proj, glob), "allow", `Grep ${glob}`);
      assert.equal(search("gemini", proj, glob), "allow", `Gemini ${glob}`);
    }
  },
);

test("a search glob with a backslash escape is read as ripgrep and grep read it", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const untouched = watchLookups(t, (value) => /fileserver\.example/i.test(value));
  const search = (tool, glob, location = root) => {
    const event =
      tool === "claude"
        ? { tool_name: "Grep", tool_input: { pattern: "DB_", path: location, glob, output_mode: "content" } }
        : { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: location, include_pattern: glob } };
    return untouched(`${tool} ${glob}`, () => guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }))
      .action;
  };
  const shell = (command) =>
    untouched(command, () =>
      guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }),
    ).action;
  for (const glob of [".e\\nv", ".e\\nv*", "proj/.\\env"]) {
    assert.equal(search("claude", glob), "block", `Grep ${glob}`);
    assert.equal(search("gemini", glob), "block", `Gemini ${glob}`);
  }
  assert.equal(search("claude", ".k\\ube/*", "\\\\fileserver.example\\home\\alex"), "block", "Grep remote .k\\ube/*");
  for (const command of [
    "rg -g '.e\\nv' DB_ proj",
    "rg --glob='.e\\nv*' DB_ proj",
    "grep -r --include='.e\\nv' DB_ proj",
    // A value quoted after its option's `=`, or joined to a short option, is read without the quotes.
    "rg --glob='.env*' DB_ proj",
    "rg -g'.env' DB_ proj",
    'grep -r --include=".env" DB_ proj',
    "rg --hidden -g '.k\\ube/*' DB_ //fileserver.example/home/alex",
  ]) {
    assert.equal(shell(command), "block", command);
  }
  assert.equal(search("claude", "*.m\\d"), "allow", "Grep *.m\\d");
  assert.equal(shell("rg -g '*.m\\d' DB_ docs"), "allow", "rg *.m\\d");
});

test("a search glob with more braces than Guard expands counts as matching every file", (t) => {
  const root = fixture(t);
  const search = (tool, glob) => {
    const event =
      tool === "claude"
        ? { tool_name: "Grep", tool_input: { pattern: "DB_", path: root, glob, output_mode: "content" } }
        : { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: root, include_pattern: glob } };
    return guard.inspectRead(tool, event, { cwd: root, searchWalkMaxMs: 10000 }).action;
  };
  const many = `{${Array.from({ length: 16 }, (_, index) => `n${index}`).join(",")},.env}`;
  for (const glob of [many, "{.,x}{e,y}{n,z}{v,w}{,q}", `proj/${many}`]) {
    assert.equal(search("claude", glob), "block", `Grep ${glob}`);
    assert.equal(search("gemini", glob), "block", `Gemini ${glob}`);
  }
  assert.equal(search("claude", "*.{md,txt}"), "allow");
});

test("a search's filter checks and slow ignore checks don't let a secret file through as a note", (t) => {
  const root = fixture(t);
  for (let index = 0; index < 200; index += 1) fs.writeFileSync(path.join(root, `n${index}.txt`), "x\n");
  // A long filter is read once for the whole walk, not once a file.
  const long = "q".repeat(100_000);
  for (const [tool, event] of [
    [
      "claude",
      {
        tool_name: "Grep",
        tool_input: { pattern: "token", path: root, glob: `${long}*.md .kube/*`, output_mode: "content" },
      },
    ],
    [
      "gemini",
      {
        tool_name: "search_file_content",
        tool_input: { pattern: "token", path: root, include_pattern: `{${long}*.md,.kube/*}` },
      },
    ],
  ]) {
    assert.equal(guard.inspectRead(tool, event, { cwd: root }).action, "block", tool);
  }
  // A Git that doesn't answer in time leaves a secret file Gemini CLI may read as a check that didn't finish.
  const bin = tempDir(t);
  const git = path.join(bin, process.platform === "win32" ? "git.exe" : "git");
  try {
    fs.linkSync(process.execPath, git);
  } catch {
    fs.copyFileSync(process.execPath, git);
  }
  fs.chmodSync(git, 0o755);
  const slow = path.join(bin, "slow.js");
  fs.writeFileSync(slow, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);\n");
  const saved = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  process.env.NODE_OPTIONS = `--require "${slow}"`;
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
  });
  const outcome = guard.inspectRead(
    "gemini",
    { tool_name: "search_file_content", tool_input: { pattern: "DB_", path: path.join(root, "proj") } },
    { cwd: root },
  );
  assert.equal(outcome.action, "block");
  assert.equal(outcome.unfinished, true);
});

test("the filesystem MCP server's read_multiple_files and read_media_file are checked as reads", (t) => {
  const root = fixture(t);
  const read = (tool, name, args) =>
    guard.inspectRead(tool, { tool_name: `mcp__fs__${name}`, tool_input: args }, { cwd: root }).action;
  for (const tool of ["codex", "claude"]) {
    for (const paths of [
      ["notes.txt", ".env"],
      [path.join(root, "notes.txt"), path.join(root, ".kube", "config")],
      ["docs/readme.md", "proj/.env"],
    ]) {
      assert.equal(read(tool, "read_multiple_files", { paths }), "block", `${tool} ${paths}`);
    }
    assert.equal(read(tool, "read_multiple_files", { paths: ["notes.txt", "docs/readme.md"] }), "allow", tool);
    assert.equal(read(tool, "read_media_file", { path: ".env" }), "block", `${tool} read_media_file`);
    assert.equal(read(tool, "read_media_file", { path: "notes.txt" }), "allow", `${tool} read_media_file`);
  }
  // Claude Code sends MCP tools to its tool hook, which checks the files a filesystem server's read names too.
  const tool = (name, args) =>
    guard.inspectTool("claude", { tool_name: `mcp__fs__${name}`, tool_input: args }, { cwd: root }).action;
  assert.equal(tool("read_text_file", { path: ".env" }), "block", "read_text_file .env");
  assert.equal(tool("read_file", { path: path.join(root, ".kube", "config") }), "block", "read_file .kube/config");
  assert.equal(tool("read_media_file", { path: "proj/.env" }), "block", "read_media_file proj/.env");
  assert.equal(tool("read_multiple_files", { paths: ["notes.txt", ".env"] }), "block", "read_multiple_files");
  assert.equal(tool("read_text_file", { path: "notes.txt" }), "allow", "read_text_file notes.txt");
  assert.equal(tool("read_multiple_files", { paths: ["notes.txt", "docs/readme.md"] }), "allow", "ordinary files");
});

test(
  "is_secret_file judges a path ending in a separator and a part Windows drops as the file",
  { skip: WINDOWS_ONLY },
  () => {
    for (const file of [
      "\\\\fileserver.example\\home\\alex\\.kube\\config\\ ",
      "\\\\fileserver.example\\home\\alex\\.kube\\config\\.",
      "\\\\fileserver.example\\home\\alex\\.kube\\config\\ .\\",
      "//fileserver.example/home/alex/.kube/config/. /",
    ]) {
      assert.equal(mcp.callTool("is_secret_file", { path: file }).is_secret_file, true, file);
    }
    assert.equal(
      mcp.callTool("is_secret_file", { path: "\\\\fileserver.example\\home\\alex\\.kube\\config\\.." }).is_secret_file,
      false,
    );
  },
);

// A home folder of made-up files, with HOME and USERPROFILE pointed at it for the test, as the assistant's shell has them.
function homeFixture(t) {
  const root = tempDir(t);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".kube"), { recursive: true });
  fs.writeFileSync(path.join(home, ".kube", "config"), "token: synthetic-not-real-123\n");
  fs.mkdirSync(path.join(home, "notes"));
  fs.writeFileSync(path.join(home, "notes", "todo.md"), "todo\n");
  fs.writeFileSync(path.join(home, "notes.txt"), "notes\n");
  if (process.platform === "win32") fs.symlinkSync(path.join(home, ".kube"), path.join(home, "kj"), "junction");
  else fs.symlinkSync(path.join(home, ".kube"), path.join(home, "kj"));
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "readme.md"), "readme\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return { root, home, proj };
}

test("a shell command's home folder, home variables and Git Bash drive paths are read as the folder they open", (t) => {
  const { home, proj } = homeFixture(t);
  const shell = (tool, toolName, command) =>
    (tool === "cursor"
      ? guard.inspectShell("cursor", { command, cwd: proj }, { cwd: proj })
      : guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: proj } }, { cwd: proj })
    ).action;
  const blocked = [
    ["claude", "Bash", "grep -r token ~/.kube"],
    ["claude", "Bash", "rg token ~/.kube"],
    ["claude", "Bash", "cp -r ~/.kube /tmp/x"],
    ["claude", "Bash", "diff -r ~/.kube other"],
    ["claude", "Bash", "grep -r token $HOME/.kube"],
    ["claude", "Bash", 'grep -r token "${HOME}/.kube"'],
    ["claude", "Bash", "cat ~/kj/config"],
    ["claude", "Bash", "grep -r token ~/kj"],
    ["claude", "Bash", "tr a b < ~/kj/config"],
    ["claude", "PowerShell", "rg token $env:USERPROFILE\\.kube"],
    ["claude", "PowerShell", "Get-Content $env:USERPROFILE\\kj\\config"],
    ["claude", "PowerShell", "cmd /c findstr /s token %USERPROFILE%\\.kube\\*"],
    ["cursor", null, "rg token ~/.kube"],
    ["cursor", null, "cat ~/kj/config"],
    // A credentials folder that isn't there as written is judged by its name: the shell may open it by another.
    ["claude", "Bash", "grep -r token $SOMEWHERE/.kube"],
    ["claude", "Bash", 'rg token "$SOMEWHERE/.ssh"'],
    ["claude", "PowerShell", "rg token $env:SOMEWHERE\\.aws"],
  ];
  if (process.platform === "win32") {
    const msys = `/${home[0].toLowerCase()}${home.slice(2).replace(/\\/g, "/")}`;
    blocked.push(
      ["claude", "Bash", `grep -r token ${msys}/.kube`],
      ["claude", "Bash", `cat ${msys}/kj/config`],
      ["claude", "Bash", `cp -r ${msys}/kj x`],
    );
  }
  for (const [tool, toolName, command] of blocked) {
    assert.equal(shell(tool, toolName, command), "block", `${tool} ${toolName} ${command}`);
  }
  for (const [tool, toolName, command] of [
    ["claude", "Bash", "grep -r todo ~/notes"],
    ["claude", "Bash", "cat ~/notes.txt"],
    ["claude", "Bash", "grep -r todo $HOME/notes"],
    ["claude", "PowerShell", "Get-Content $env:USERPROFILE\\notes.txt"],
    ["cursor", null, "rg todo ~/notes"],
  ]) {
    assert.equal(shell(tool, toolName, command), "allow", `${tool} ${toolName} ${command}`);
  }
});

test("a read or search of a path under the home folder (`~/...`) is checked as the file it opens", (t) => {
  const { proj } = homeFixture(t);
  const read = (tool, event) => guard.inspectRead(tool, event, { cwd: proj });
  for (const [tool, event] of [
    ["claude", { tool_name: "Read", tool_input: { file_path: "~/kj/config" } }],
    ["claude", { tool_name: "Grep", tool_input: { pattern: "token", path: "~/.kube", output_mode: "content" } }],
    ["claude", { tool_name: "Grep", tool_input: { pattern: "token", path: "~/kj", output_mode: "content" } }],
    ["codex", { tool_name: "mcp__fs__read_file", tool_input: { path: "~/kj/config" } }],
    ["codex", { tool_name: "mcp__fs__read_multiple_files", tool_input: { paths: ["~/notes.txt", "~/kj/config"] } }],
    ["codex", { tool_name: "mcp__fs__search_files", tool_input: { path: "~/kj", pattern: "config" } }],
    ["gemini", { tool_name: "search_file_content", tool_input: { pattern: "token", path: "~/kj" } }],
  ]) {
    assert.equal(read(tool, event).action, "block", `${tool} ${JSON.stringify(event)}`);
  }
  assert.equal(
    guard.inspectTool(
      "claude",
      { tool_name: "mcp__fs__read_text_file", tool_input: { path: "~/kj/config" } },
      { cwd: proj },
    ).action,
    "block",
  );
  // An ordinary file there is read without a note.
  const ordinary = read("codex", { tool_name: "mcp__fs__read_file", tool_input: { path: "~/notes.txt" } });
  assert.equal(ordinary.action, "allow");
  assert.equal(ordinary.internalError, undefined);
});

test("a read or search naming its path under more than one key is checked at each", (t) => {
  const root = fixture(t);
  const read = (tool, event) => guard.inspectRead(tool, event, { cwd: root }).action;
  for (const args of [
    { path: ".env", file_path: "notes.txt" },
    { file_path: "notes.txt", absolute_path: "docs/readme.md", path: ".kube/config" },
  ]) {
    assert.equal(
      guard.inspectTool("claude", { tool_name: "mcp__fs__read_text_file", tool_input: args }, { cwd: root }).action,
      "block",
      `claude MCP ${JSON.stringify(args)}`,
    );
    assert.equal(read("codex", { tool_name: "mcp__fs__read_file", tool_input: args }), "block", "codex");
    assert.equal(read("claude", { tool_name: "Read", tool_input: args }), "block", "claude Read");
    assert.equal(read("gemini", { tool_name: "read_file", tool_input: args }), "block", "gemini read_file");
  }
  assert.equal(
    read("gemini", {
      tool_name: "search_file_content",
      tool_input: { pattern: "token", path: "docs", dir_path: ".kube" },
    }),
    "block",
    "gemini dir_path",
  );
  assert.equal(
    read("claude", {
      tool_name: "Grep",
      tool_input: { pattern: "DB_", path: "docs", dir_path: "proj", output_mode: "content" },
    }),
    "block",
    "claude Grep dir_path",
  );
  assert.equal(
    read("codex", { tool_name: "mcp__fs__read_file", tool_input: { path: "notes.txt", file_path: "docs/readme.md" } }),
    "allow",
  );
});

test("a read hook's ripgrep listing too big for its buffer is answered from ripgrep's rules", (t) => {
  const root = tempDir(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(root, ".env"), "DB_PASSWORD=synthetic-not-real-123\n");
  fs.writeFileSync(path.join(root, "notes.md"), "notes\n");
  // An rg whose listing (about a megabyte) is past the read hook's buffer: a fresh copy of Guard runs this script,
  // with the options Guard gives rg, whenever it starts rg.
  const big = path.join(tempDir(t), "big.js");
  fs.writeFileSync(
    big,
    'const name = "f".repeat(200);\n' +
      'let out = "";\n' +
      "for (let i = 0; i < 5000; i += 1) out += `src/${name}${i}.md\\0`;\n" +
      "process.stdout.write(out, () => process.exit(0));\n",
  );
  const childProcess = require("child_process");
  const guardPath = require.resolve("../apps/guard/bin/clotr-guard.js");
  const real = childProcess.spawnSync;
  const loaded = require.cache[guardPath];
  let started = 0;
  childProcess.spawnSync = function bigRipgrep(command, args, options) {
    if (command !== "rg") return real.call(this, command, args, options);
    started += 1;
    return real.call(this, process.execPath, [big], options);
  };
  delete require.cache[guardPath];
  let bigGuard;
  try {
    bigGuard = require(guardPath);
  } finally {
    childProcess.spawnSync = real;
    require.cache[guardPath] = loaded;
  }
  const search = () =>
    bigGuard.inspectRead(
      "claude",
      { tool_name: "Grep", tool_input: { pattern: "notes", path: root, output_mode: "content" } },
      // Time for the stand-in to start on a busy computer; only the buffer is tested.
      { cwd: root, deadline: Date.now() + 10000, searchWalkMaxMs: 10000 },
    );
  // ripgrep leaves the git-ignored .env out, so the search goes through.
  const outcome = search();
  assert.ok(started > 0, "rg was started");
  assert.equal(outcome.action, "allow");
  assert.equal(outcome.unfinished, undefined);
  // Not ignored, it's found.
  fs.writeFileSync(path.join(root, ".gitignore"), "");
  const found = search();
  assert.equal(found.action, "block");
  assert.equal(found.secretFile, true);
});

test("a read or search with a value other than text under one path key checks the path under another", (t) => {
  const root = fixture(t);
  const read = (tool, event) => guard.inspectRead(tool, event, { cwd: root }).action;
  for (const decoy of [1, true, [], {}]) {
    assert.equal(
      read("codex", { tool_name: "mcp__fs__read_file", tool_input: { file_path: decoy, path: ".env" } }),
      "block",
      `codex ${JSON.stringify(decoy)}`,
    );
    assert.equal(
      guard.inspectTool(
        "claude",
        { tool_name: "mcp__fs__read_text_file", tool_input: { file_path: decoy, path: ".env" } },
        { cwd: root },
      ).action,
      "block",
      `claude MCP ${JSON.stringify(decoy)}`,
    );
    assert.equal(
      read("gemini", {
        tool_name: "read_file",
        tool_input: { file_path: decoy, absolute_path: path.join(root, ".env") },
      }),
      "block",
      `gemini read_file ${JSON.stringify(decoy)}`,
    );
  }
  // The folder searched is the one named by text; a search of the clean docs folder with `path: 1` reads proj.
  const docs = path.join(root, "docs");
  for (const name of ["search_file_content", "grep_search"]) {
    assert.equal(
      guard.inspectRead(
        "gemini",
        { tool_name: name, tool_input: { pattern: "DB_", path: 1, dir_path: "../proj" } },
        { cwd: docs },
      ).action,
      "block",
      `gemini ${name}`,
    );
  }
});

test("a PowerShell list of paths (`gc notes.txt,.env`) has each path checked", (t) => {
  const root = fixture(t);
  const shell = (toolName, command) =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
  for (const command of [
    "gc .env,notes.txt",
    "Get-Content notes.txt,.env",
    "Get-Content -Path notes.txt,.kube/config",
    'Get-Content "notes.txt",.env',
    "Select-String DB_ notes.txt,.env",
  ]) {
    assert.equal(shell("PowerShell", command), "block", command);
  }
  assert.equal(
    guard.inspectShell("cursor", { command: "gc notes.txt,.env", cwd: root }, { cwd: root }).action,
    "block",
    "cursor",
  );
  assert.equal(shell("PowerShell", "rg --hidden DB_ docs,proj"), "block", "rg docs,proj");
  assert.equal(shell("PowerShell", "gc notes.txt,docs/readme.md"), "allow");
});

test("a one-letter switch (`/s`, `/i`) isn't looked up as a drive", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const roots = [];
  const own = path.parse(root).root[0].toUpperCase();
  const names = ["lstatSync", "statSync", "existsSync", "readdirSync", "realpathSync", "accessSync", "openSync"];
  const saved = names.map((name) => [name, fs[name]]);
  for (const [name, original] of saved) {
    fs[name] = function (...args) {
      const value = typeof args[0] === "string" ? args[0] : "";
      const drive = /^([a-z]):[\\/]*$/i.exec(value);
      if (drive && drive[1].toUpperCase() !== own) roots.push(`${name} ${value}`);
      return original.apply(this, args);
    };
  }
  t.after(() => {
    for (const [name, original] of saved) fs[name] = original;
  });
  for (const [toolName, command] of [
    ["PowerShell", "findstr /s /i todo *.md"],
    ["PowerShell", "findstr /i /n todo notes.txt"],
    ["PowerShell", "sort /r notes.txt"],
    ["PowerShell", "more /e notes.txt"],
    ["Bash", "sort /r notes.txt"],
  ]) {
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root });
  }
  guard.inspectShell("cursor", { command: "findstr /s /i todo *.md", cwd: root }, { cwd: root });
  assert.deepEqual(roots, []);
});

test("a credentials folder named through a variable the check can't read, or with quotes inside the word, is stopped", (t) => {
  const { proj } = homeFixture(t);
  const bash = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: proj } }, { cwd: proj }).action;
  for (const command of [
    "grep -r token $SOMEWHERE/.kub?",
    "grep -r token $SOMEWHERE/.kub[e]",
    "grep -r token $SOMEWHERE/.k*e",
    "rg x $SOMEWHERE/.ss?",
    'cat "$HOME"/kj/config',
    'rg token "$HOME"/kj',
    'grep -r token "$HOME"/.kube',
  ]) {
    assert.equal(bash(command), "block", command);
  }
  // A folder that isn't there, named outright, opens nothing, whatever its name.
  for (const command of ["grep -r TODO gh", "grep -r TODO cmd/gh", "rg TODO .config/gh"]) {
    assert.equal(bash(command), "allow", command);
  }
  assert.equal(bash('cat "$HOME"/notes.txt'), "allow");
});

test("is_secret_file judges a home folder path (`~/...`) as the file under the home folder", (t) => {
  const { home } = homeFixture(t);
  assert.deepEqual(mcp.callTool("is_secret_file", { path: "~/kj/config" }), { is_secret_file: true });
  assert.deepEqual(mcp.callTool("is_secret_file", { path: "~/notes.txt" }), { is_secret_file: false });
  assert.deepEqual(mcp.callTool("is_secret_file", { path: path.join(home, "kj", "config") }), {
    is_secret_file: true,
  });
});

// A Windows path as Git Bash writes it: `C:\x` is `/c/x`.
function gitBashPath(windowsPath) {
  return `/${windowsPath[0].toLowerCase()}${windowsPath.slice(2).replace(/\\/g, "/")}`;
}

test("a Git Bash drive path is read as the drive path however it's written", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const bash = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: root } }, { cwd: root }).action;
  const cursor = (command) => guard.inspectShell("cursor", { command, cwd: root }, { cwd: root }).action;
  const proj = gitBashPath(path.join(root, "proj"));
  const kube = gitBashPath(path.join(root, ".kube"));
  const link = gitBashPath(path.join(root, "kubelink"));
  for (const command of [
    // A whole drive is read for every file on it.
    "grep -r DB_PASSWORD /c",
    "rg DB_PASSWORD /d/",
    "grep -rl x /c /d /e",
    "grep -r x /cygdrive/c",
    `grep -r DB_ /.${proj}`,
    `rg -uu DB_ /tmp/..${proj}`,
    `cat /.${link}/config`,
    `cat /usr/..${link}/config`,
    `cat /proc/cygdrive${link}/config`,
    `tr a b < /.${link}/config`,
    `grep -r token /.${kube}`,
  ]) {
    assert.equal(bash(command), "block", command);
  }
  // Cursor's shell may be Git Bash: a credentials folder written that way is judged by its name.
  for (const command of [`grep -r token ${kube}`, `rg token ${kube}`]) {
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  assert.equal(bash(`cat ${gitBashPath(path.join(root, "notes.txt"))}`), "allow");
});

test("a PowerShell parameter's value written after a colon (`-Path:.env`) is read as a path", (t) => {
  const root = fixture(t);
  const ps = (command) =>
    guard.inspectShell("claude", { tool_name: "PowerShell", tool_input: { command, cwd: root } }, { cwd: root }).action;
  const commands = [
    "gc -Path:.env",
    "Get-Content -LiteralPath:.env",
    "Select-String -Pattern DB -Path:.env",
    "copy -Path:.env out.txt",
    "Get-Content -Path:notes.txt,.env",
  ];
  if (process.platform === "win32") commands.push("Get-Content -Path:kubelink/config");
  for (const command of commands) assert.equal(ps(command), "block", command);
  assert.equal(guard.inspectShell("cursor", { command: "gc -Path:.env", cwd: root }, { cwd: root }).action, "block");
  assert.equal(ps("Get-Content -Path:notes.txt"), "allow");
});

test("a shell's own quoting and escapes are read as the shell reads them", (t) => {
  const root = fixture(t);
  const shell = (toolName, command) =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd: root } }, { cwd: root }).action;
  const blocked = [
    ["Bash", "cat $'.env'"],
    ["Bash", 'cat $".env"'],
    ["Bash", "cat $'.e\\x6ev'"],
    ["Bash", "tr a b < $'.env'"],
    ["Bash", "cat .e\\nv"],
    ["Bash", "tr a b < '.e'nv"],
    ["Bash", 'tr a b < ".e"nv'],
    ["PowerShell", "gc `.env"],
    ["PowerShell", "gc notes.txt,`.env"],
    ["PowerShell", "cmd /c type .e^nv"],
  ];
  if (process.platform === "win32") {
    blocked.push(
      ["Bash", "grep -r token $'kubelink'"],
      ["Bash", "cat kubelin\\k/config"],
      ["Bash", "tr a b < kubelin'k'/config"],
    );
  }
  for (const [toolName, command] of blocked) assert.equal(shell(toolName, command), "block", `${toolName} ${command}`);
  assert.equal(
    guard.inspectShell("cursor", { command: "cmd /c type .e^nv", cwd: root }, { cwd: root }).action,
    "block",
    "cursor cmd",
  );
  for (const [toolName, command] of [
    ["Bash", "cat notes\\.txt"],
    ["Bash", "cat $'notes.txt'"],
    ["PowerShell", "gc `notes.txt"],
    ["PowerShell", "cmd /c type note^s.txt"],
  ]) {
    assert.equal(shell(toolName, command), "allow", `${toolName} ${command}`);
  }
});

test("an input redirection's target is read as the shell joins its quoted parts", (t) => {
  const { proj } = homeFixture(t);
  const bash = (command) =>
    guard.inspectShell("claude", { tool_name: "Bash", tool_input: { command, cwd: proj } }, { cwd: proj }).action;
  assert.equal(bash('tr a b < "$HOME"/kj/config'), "block");
  assert.equal(bash("tr a b < ~/'kj'/config"), "block");
  assert.equal(bash('tr a b < "$HOME"/notes.txt'), "allow");
});

test("a PowerShell provider path (`FileSystem::C:\\...`) is read as the path it names", { skip: WINDOWS_ONLY }, (t) => {
  const root = fixture(t);
  const link = path.join(root, "kubelink", "config");
  for (const command of [
    `gc FileSystem::${link}`,
    `gc Microsoft.PowerShell.Core\\FileSystem::${link}`,
    `sls -Path FileSystem::${link} -Pattern token`,
  ]) {
    assert.equal(
      guard.inspectShell("claude", { tool_name: "PowerShell", tool_input: { command, cwd: root } }, { cwd: root })
        .action,
      "block",
      command,
    );
    assert.equal(
      guard.inspectShell("cursor", { command, cwd: root }, { cwd: root }).action,
      "block",
      `cursor ${command}`,
    );
  }
  assert.equal(
    guard.inspectShell(
      "claude",
      { tool_name: "PowerShell", tool_input: { command: `gc FileSystem::${path.join(root, "notes.txt")}`, cwd: root } },
      { cwd: root },
    ).action,
    "allow",
  );
});

test("a recursive reader given the same home folder path many times walks it once", (t) => {
  const { proj } = homeFixture(t);
  const command = `rg x ${"~/notes ".repeat(250000)}`;
  const outcome = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command, cwd: proj } },
    { cwd: proj },
  );
  assert.equal(outcome.unfinished, undefined);
  assert.equal(outcome.action, "allow");
});

// Claude Code's Bash and PowerShell tools and Cursor's shell, from a folder.
function shellsAt(cwd) {
  const claude = (toolName) => (command) =>
    guard.inspectShell("claude", { tool_name: toolName, tool_input: { command, cwd } }, { cwd }).action;
  return {
    bash: claude("Bash"),
    ps: claude("PowerShell"),
    cursor: (command) => guard.inspectShell("cursor", { command, cwd }, { cwd }).action,
  };
}

test("a shell's escapes are read past a comment, a here-doc or a quote the shell doesn't pair", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  for (const command of [
    "echo hi #'\ncat .e\\nv",
    'echo hi # say "hi\ncat .e\\nv',
    "cat <<EOF\nit's fine\nEOF\ncat .e\\nv",
    "echo $'\\c'; cat .e\\nv",
  ]) {
    assert.equal(bash(command), "block", command);
  }
  for (const command of ["# it's\ngc `.env", "<# it's #> gc `.env"]) assert.equal(ps(command), "block", command);
  assert.equal(cursor("echo hi # it's\ncat .e\\nv"), "block");
});

test("cmd's carets are read inside the quotes `cmd /c` takes off", (t) => {
  const { ps, cursor } = shellsAt(fixture(t));
  assert.equal(ps('cmd /c "type .e^nv"'), "block");
  assert.equal(cursor('cmd /c "type .e^nv"'), "block");
  assert.equal(ps('cmd /c "type note^s.txt"'), "allow");
});

test("PowerShell's curly quotes and dashes are read as quotes and dashes", (t) => {
  const root = fixture(t);
  const { ps, cursor } = shellsAt(root);
  const commands = ["gc \u2018.env\u2019", "gc \u201c.env\u201d", "gc \u2013Path:.env", "gc \u2014Path:.env"];
  if (process.platform === "win32") commands.push("gc \u2015LiteralPath:kubelink/config");
  for (const command of commands) {
    assert.equal(ps(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  assert.equal(ps("gc \u2018notes.txt\u2019"), "allow");
});

test("a reader whose name is quoted is read as that reader", (t) => {
  const { bash, ps } = shellsAt(fixture(t));
  const commands = ['"cat" .env', "'cat' .env", "c''at .env", "$'cat' .env", "$'\\x63at' .env", "'grep' -r DB_ proj"];
  if (process.platform === "win32") commands.push("'grep' -r token kubelink");
  for (const command of commands) assert.equal(bash(command), "block", command);
  for (const command of ["& 'gc' .env", "& \u2018gc\u2019 .env"]) assert.equal(ps(command), "block", command);
  assert.equal(bash("'cat' notes.txt"), "allow");
});

test("a read-write redirection's file is read", (t) => {
  const { bash } = shellsAt(fixture(t));
  assert.equal(bash("cat <>.env"), "block");
  assert.equal(bash("tr a b <>.env"), "block");
  if (process.platform === "win32") assert.equal(bash("tr a b 0<>kubelink/config"), "block");
  assert.equal(bash("tr a b <>notes.txt"), "allow");
});

test("an input redirection's target with a quote that isn't closed is read", (t) => {
  const { ps, cursor } = shellsAt(fixture(t));
  // cmd reads `<".env` as `.env`: its quote needn't close.
  for (const command of ['sort <".env', 'tr a b <".kube/config']) {
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  for (const command of ["cmd /c 'sort < \".env'", "cmd /c 'sort <\".env'"]) {
    assert.equal(ps(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  assert.equal(cursor('sort <"notes.txt'), "allow");
});

test("a shell's other names for the working folder (`/proc/self/cwd`, `~+`) are read as the working folder", (t) => {
  const { bash } = shellsAt(fixture(t));
  const commands = ["grep -r DB_ /proc/self/cwd/proj", "grep -r DB_ /proc/self/cwd", "grep -r DB_ ~+/proj"];
  if (process.platform === "win32") {
    commands.push("cat /proc/self/cwd/kubelink/config", "cat ~+/kubelink/config", "grep -r token ~+/kubelink");
  }
  for (const command of commands) assert.equal(bash(command), "block", command);
  assert.equal(bash("cat ~+/notes.txt"), "allow");
});

test("a variable inside a word is also read as empty", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  assert.equal(bash("cat .e${X}nv"), "block");
  assert.equal(bash("cat .e$X'n'v"), "block");
  assert.equal(ps("cmd /c type .e%COMSPEC:~0,0%nv"), "block");
  assert.equal(cursor("cat .e${X}nv"), "block");
  // A variable that is the whole folder still isn't read as the working folder.
  assert.equal(bash("grep -r x $SRC"), "allow");
  assert.equal(bash("cat notes${X}.txt"), "allow");
});

test("an escaped backslash in a search pattern doesn't make the pattern a folder", (t) => {
  const { bash, cursor } = shellsAt(fixture(t));
  for (const command of ['grep -rn "\\\\" docs', 'grep -rn "C:\\\\Users" docs', 'grep -rn "\\$x" docs']) {
    assert.equal(bash(command), "allow", command);
  }
  assert.equal(cursor('rg -n "\\\\" docs'), "allow");
});

test("PowerShell's `u{...} escape is read", (t) => {
  const { ps } = shellsAt(fixture(t));
  assert.equal(ps('gc "`u{2e}env"'), "block");
  assert.equal(ps('gc "`u{6e}otes.txt"'), "allow");
});

test("a `#` starts a comment only at a word's start, and a comment's text is kept", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  for (const command of [
    "cat x\\ #y .e\\nv",
    "cat x\\;#y .e\\nv",
    "cat x\\|#y .e\\nv",
    "cat x\\\n#y .e\\nv",
    "cat ${X:- #} .e\\nv",
  ]) {
    assert.equal(bash(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  for (const command of [
    "gc x` #y,`.env",
    "gc x`;#y,`.env",
    "gc x`(#y,`.env",
    "gc x<#,`.env -ErrorAction SilentlyContinue",
  ]) {
    assert.equal(ps(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  // A comment's text is still there for the command before it, so grep keeps its words.
  for (const check of [bash, ps, cursor]) assert.equal(check("grep -rn #TODO notes.txt"), "allow");
});

test("a here-doc's or here-string's body doesn't hide the escapes after it", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  const hereDoc = 'cat <<EOF\ndon\'t\nEOF\necho "a\n"; cat .e\\nv';
  const tabbed = "cat <<-'EOF'\n\tdon't\n\tEOF\necho \"a\n\"; cat .e\\nv";
  const hereString = "$x = @'\ndon't\n'@\necho 'a\n'; gc `.env";
  assert.equal(bash(hereDoc), "block");
  assert.equal(bash(tabbed), "block");
  assert.equal(cursor(hereDoc), "block");
  assert.equal(ps(hereString), "block");
  assert.equal(cursor(hereString), "block");
  assert.equal(bash("cat <<EOF\ndon't\nEOF\ncat notes.txt"), "allow");
});

test("Bash's directory-stack and /proc names for the working folder are read as the working folder", (t) => {
  const { bash, cursor } = shellsAt(fixture(t));
  const commands = [
    "grep -r DB_ ~0",
    "grep -r DB_ ~+0/proj",
    "grep -r DB_ ~-0/proj",
    "grep -r DB_ /proc//self/cwd/proj",
    "grep -r DB_ /proc/./self/cwd",
    "grep -r DB_ /./proc/self/cwd/proj",
    "grep -r DB_ /proc/self/root/proc/self/cwd/proj",
  ];
  if (process.platform === "win32") commands.push("cat ~0/kubelink/config", "cat /proc//self/cwd/kubelink/config");
  for (const command of commands) {
    assert.equal(bash(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  assert.equal(bash("cat ~0/notes.txt"), "allow");
});

test("a variable's default value is read in its place", (t) => {
  const { bash, cursor } = shellsAt(fixture(t));
  for (const command of ["cat .e${X:-n}v", "cat .e${X-n}v", "cat .e${X:=n}v", "cat .e${X:+n}v", "cat ${X:-.env}"]) {
    assert.equal(bash(command), "block", command);
    assert.equal(cursor(command), "block", `cursor ${command}`);
  }
  assert.equal(bash("cat notes${X:-}.txt"), "allow");
});

test("a run of unclosed `${` is read in linear time", (t) => {
  const root = fixture(t);
  const command = `cat a${"${a".repeat(250000)}`;
  const started = Date.now();
  const outcome = guard.inspectShell(
    "claude",
    { tool_name: "Bash", tool_input: { command, cwd: root } },
    { cwd: root },
  );
  assert.equal(outcome.unfinished, undefined);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("PowerShell's `u{...} escape is read outside quotes too", (t) => {
  const { ps } = shellsAt(fixture(t));
  assert.equal(ps("gc `u{2e}env"), "block");
  assert.equal(ps("gc `u{6e}otes.txt"), "allow");
});

test("a here-doc, here-string or comment Guard misreads doesn't hide the lines after it", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  for (const command of [
    "cat <<E\\OF\nhi\nEOF\ncat .e\\nv",
    'cat <<E"O"F\nhi\nEOF\ncat .e\\nv',
    "cat <<$'EOF'\nhi\nEOF\ncat .e\\nv",
    // The plain reading can't see these, as the stray quote opens a quote it never closes.
    'cat <<E\\OF\ndon\'t\nEOF\necho "a\n"; cat .e\\nv',
    "cat <<'E'OF\ndon't\nEOF\necho \"a\n\"; cat .e\\nv",
    "cat <<<hi\ncat .e\\nv",
    "echo $((1<<X))\ncat .e\\nv",
    "(( y = 1 << Z ))\ncat .e\\nv",
    "(true)#<<X\ncat .e\\nv",
    "true # x\r<<X\ncat .e\\nv",
    "echo $[1<<2]\ncat .e\\nv",
    // The plain reading joins these lines at the escaped line break the comment holds.
    "(true)#<<X \\\ncat .e\\nv",
    "true # x\r<<X \\\ncat .e\\nv",
    "echo a\v#;cat .e\\nv",
    "echo a #;cat .e\\nv",
    // A shift in an array's subscript or list isn't a here-doc, and `$$` doesn't open a `${`.
    "a[1<<2]=3\n# x\\\ncat .e\\nv",
    "a[1<<2]=3\n# x \\\ncat \\\n.e\\nv",
    "a=(1 <<X 2)\n# x\\\ncat .e\\nv\nX",
    "echo $${\n#\\\ncat .e\\nv",
    "echo $${\n# x \\\ncat \\\n.e\\nv",
  ]) {
    assert.equal(bash(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
  for (const command of [
    "(1)#@'\ngc `.env",
    "{1}#@'\ngc `.env",
    "'a'#@'\ngc `.env",
    "echo a@'\nx'; gc `.env\n'@'",
    'echo a@"\nx"; gc `.env\n"@"',
  ]) {
    assert.equal(ps(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
});

test("a comment ending in an escape doesn't join the next line when Guard misreads what's before it", (t) => {
  const { bash, cursor } = shellsAt(fixture(t));
  for (const command of [
    "if((1<<2)); then :; fi # x \\\ncat .e\\nv",
    "for((i=0;i<1<<2;i++)); do :; done # x \\\ncat .e\\nv",
    "if((1<<2)); then :; fi\n# x \\\ncat .e\\nv",
    "echo `cat <<EOF` # x \\\ncat .e\\nv",
    "a[1${y#]}<<2]=3 # x \\\ncat .e\\nv",
    'echo "${x:-\'"\\\'}" # x \\\ncat .e\\nv',
    // With the false here-doc's delimiter after the reader, and the reader's words on two lines.
    "if((1<<2)); then :; fi # x \\\ncat \\\n.e\\nv\n2",
    "echo `cat <<EOF` # x \\\ncat \\\n.e\\nv\nEOF",
    "a[1${y#]}<<2]=3 # x \\\ncat \\\n.e\\nv\n2",
  ]) {
    assert.equal(bash(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
});

test("quotes nested in a double quote's command or variable pair as the shell pairs them", (t) => {
  const { bash, ps, cursor } = shellsAt(fixture(t));
  for (const command of [
    'echo "$(echo "\'")"; cat .e\\nv',
    'echo "`echo "\'"`"; cat .e\\nv',
    'echo "${x:-"\'"}"; cat .e\\nv',
    'echo "$(echo "$(echo "\'")")"; cat .e\\nv',
    'echo "${x:-$(echo ")")}"; cat .e\\nv',
    // Bash ends `${` at its first `}`, a bare `{` not counting.
    'echo "${x:-{}"; cat .e\\nv',
    'echo "${x:-{}"; cat .e\\nv; echo "}"',
    // A command in a variable a double quote holds pairs its own quotes and brackets too.
    'echo "${x:-$(echo })"\'"}"; cat .e\\nv',
    // A `case` pattern's `)` doesn't end the command.
    'echo "$(case x in a) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(case x in (a) echo q;; b|c) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(echo `case x in a) echo q;; esac`)\'"; cat .e\\nv',
    // Bash takes `case`, `in` and `esac` as keywords only where its grammar has them, and after taking out an escaped
    // line break, which it also does between `$` and `(`.
    'echo "$(case x in a|esac) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(case x in a) echo esac;; b) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(case x in a) echo case;; b) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(ca\\\nse x in a) echo "\'";; esac)"; cat .e\\nv',
    'echo "$(case x i\\\nn a) echo "\'";; esac)"; cat .e\\nv',
    'echo "$\\\n(echo "\'")"; cat .e\\nv',
    // With extglob on, a pattern's `@(...)` holds its own brackets.
    'echo "$(case x in @(a|b)) echo "\'";; esac)"; cat .e\\nv',
  ]) {
    assert.equal(bash(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
  for (const command of ['echo "$(echo "\'")"; gc `.env']) {
    assert.equal(ps(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
});

test("a Bash backtick's command and a PowerShell braced variable are read as the shell reads them", (t) => {
  const root = fixture(t);
  const { bash, ps, cursor } = shellsAt(root);
  for (const command of [
    // A backtick ends at the next one an escape doesn't take, whatever quotes are in it.
    "echo `echo '`; cat .e\\nv; echo \"'\"",
    "echo `echo '`; cat $'.env'; echo \"'\"",
    'echo "`echo \'`"; cat .e\\nv; echo "\'"',
    'echo "$(echo `echo \'`)"; cat .e\\nv; echo "\'"',
    'echo "${x:-`echo \'`}"; cat .e\\nv; echo "\'"',
    // Bash takes a level of backslashes off in a backtick.
    "echo `cat .e\\\\nv`",
    'echo "`cat .e\\\\nv`"',
    "echo `echo \\`cat .e\\\\\\\\nv\\``",
  ]) {
    assert.equal(bash(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
  for (const command of ["${'}; gc `.env; echo 'x'"]) {
    assert.equal(ps(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
  for (const command of [
    "echo `date +%s` `git rev-parse HEAD`; cat notes.txt",
    "echo `echo \\`date\\``; cat notes.txt",
    'Write-Output "${env:USERPROFILE}\\x"; Get-Content notes.txt',
    "$script:count = 1; $global:x = 2; $env:FOO = 'bar'",
  ]) {
    assert.equal(cursor(command), "allow", `cursor ${JSON.stringify(command)}`);
  }
  // A Bash command isn't read as PowerShell's where PowerShell can't parse it (a `<` outside a string is reserved
  // there), so a here-doc's Markdown code spans aren't read as escapes; and Bash's `${X:-...}` and `"$f:..."` are
  // Bash's variables.
  for (const command of [
    "git commit -m \"$(cat <<'EOF'\nDocument `.env.example` usage\nEOF\n)\"",
    "cat > README.md <<'EOF'\nCopy `.env.example` to `.env` and fill it in.\nEOF",
    'gh pr create --title "x" --body "$(cat <<\'EOF\'\n- Reads `.env` only when needed\nEOF\n)"',
    "cat > NOTES.md <<'EOF'\nKeep `id_rsa` key and `credentials.json` file out.\nEOF",
    'kubectl --kubeconfig "${KUBECONFIG:-$HOME/.kube/config}" get pods',
    'export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"',
    'for f in src/*.js; do echo "$f:credentials"; done',
  ]) {
    assert.equal(bash(command), "allow", JSON.stringify(command));
    assert.equal(ps(command), "allow", `powershell ${JSON.stringify(command)}`);
    assert.equal(cursor(command), "allow", `cursor ${JSON.stringify(command)}`);
  }
  // A comment's Markdown code spans aren't read as PowerShell's escapes; one before the comment still is.
  for (const command of [
    "Get-Content notes.txt # see `.env.example` docs",
    "cat notes.txt # `.env.example` usage",
    "Get-Content notes.txt -TotalCount 20 # `credentials` setup notes",
    "Get-Content notes.txt <# `.env.local` is skipped #>",
    'Get-Content notes.txt # see "`.env.example` docs"',
    'Get-Content notes.txt <# see "`.env.example` docs" #>',
    'Get-Content notes.txt\n# see "`.env.example` docs"',
    'Get-Content notes.txt # copy "`.env.example`" to "`.env`"',
    "Get-Content notes.txt # it's `.env.example` docs",
  ]) {
    assert.equal(ps(command), "allow", `powershell ${JSON.stringify(command)}`);
    assert.equal(cursor(command), "allow", `cursor ${JSON.stringify(command)}`);
  }
  // A multi-line message's Markdown code spans aren't read as PowerShell's escapes either, in a here-string or a quote.
  // (In a double quote PowerShell does read them: `` `.env` `` there is `.env`.)
  const messages = [];
  for (const line of ["Copy `.env.example` and edit it", "Type `.env.example` values by hand"]) {
    messages.push(`git commit -m @'\nDocs\n\n${line}\n'@`, `git commit -m "Docs\n\n${line}"`);
  }
  messages.push(
    "git commit -m @'\nDocs\n\nCopy `.env.example` to `.env` first\n'@",
    "Set-Content -Path docs\\setup.md -Value @'\n# Setup\nCopy `.env.example` to `.env` first\n'@",
    "git commit -m 'Docs\n\nCopy `.env.example` to `.env` first'",
    "git commit -m @'\nDocs\n\nDon't copy `.env.example` blindly\n'@",
  );
  for (const command of messages) {
    assert.equal(ps(command), "allow", `powershell ${JSON.stringify(command)}`);
    assert.equal(cursor(command), "allow", `cursor ${JSON.stringify(command)}`);
  }
  // PowerShell passes on the rest of a line after `--%` as written, `<` and all, so it runs the command, as it does one
  // with a `<` inside a word. A `#` inside a word (after `=`, `$(...)` or a backtick's command) starts no comment.
  for (const command of [
    "gc .e`nv # see `.env.example` docs",
    "gc notes.txt <# x #> .e`nv",
    "gc `.env; cmd --% /c sort < notes.txt",
    "cmd --% /c sort < notes.txt\ngc `.env",
    "echo a<b; gc `.env",
    "git log -1 --pretty=format:<%h>; gc `.env",
    "echo a=#x; gc `.env",
    "git log -1 --format=#%h; gc `.env",
    "echo a=<#x#>b; gc `.env",
  ]) {
    assert.equal(ps(command), "block", `powershell ${JSON.stringify(command)}`);
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
  for (const command of ["echo $(echo a)#x; cat .e\\nv", "echo `echo a`#x; cat .e\\nv", "echo $((1))#x; cat .e\\nv"]) {
    assert.equal(bash(command), "block", JSON.stringify(command));
    assert.equal(cursor(command), "block", `cursor ${JSON.stringify(command)}`);
  }
});
