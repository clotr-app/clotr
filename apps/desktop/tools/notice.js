// apps/desktop/NOTICE: everything Clotr for Windows is made of or runs on, one line each, with its licence. The Rust
// crates are read from Cargo.lock as built for Windows (cargo metadata), so the list can't fall behind: npm test in
// apps/desktop fails when it has (node tools/notice.js --check), and node tools/notice.js writes it again.
"use strict";

const fs = require("fs");
const path = require("path");
const { cargo } = require("./rust");

const FILE = path.join(__dirname, "..", "NOTICE");

const HEAD = `Clotr for Windows
Copyright (C) the Clotr authors. Licensed under the GNU Affero General Public License, version 3 or later
(AGPL-3.0-or-later). See LICENSE at the top of this repository.

What it is made of, besides its own code, and each part's licence. Every licence here allows use in an
AGPL-3.0-or-later program; MPL-2.0 files stay under MPL-2.0. Checked by cargo deny (src-tauri/deny.toml).

Inside the app
- Clotr's engine (detection, decisions, words, the move file), the extension's own files: AGPL-3.0-or-later
- Recursive variable font: SIL Open Font License 1.1 (design/suite/fonts/OFL-Recursive.txt)
- Atkinson Hyperlegible font, Braille Institute of America: SIL Open Font License 1.1 (design/suite/fonts/OFL.txt)

On the computer, not part of the app
- Microsoft Edge WebView2 Runtime (Windows' own web view; installed with Windows, updated by Windows):
  Microsoft Software License Terms

To build it, not part of the app
- @tauri-apps/cli 2.12.1 (the Tauri command line): MIT OR Apache-2.0
- cargo-deny 0.20.2 (the licence and ban check): MIT OR Apache-2.0

Rust crates the app is built from, for Windows (from Cargo.lock; build-time crates included)
`;

function crates() {
  const { status, stdout } = cargo(
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-pc-windows-msvc"],
    { capture: true },
  );
  if (status !== 0) throw new Error("cargo metadata failed");
  const meta = JSON.parse(stdout);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const root = meta.resolve.root;
  // Everything reachable from the app through normal and build dependencies (not test-only ones).
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of nodes.get(id)?.deps || []) {
      if (d.dep_kinds.some((k) => k.kind !== "dev")) walk(d.pkg);
    }
  };
  walk(root);
  seen.delete(root);
  return [...seen]
    .map((id) => byId.get(id))
    .map((p) => `- ${p.name} ${p.version}: ${p.license || `see ${p.license_file}`}`)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function text() {
  return `${HEAD}${crates().join("\n")}\n`;
}

if (require.main === module) {
  const now = text();
  if (process.argv.includes("--check")) {
    const ok = fs.existsSync(FILE) && fs.readFileSync(FILE, "utf8") === now;
    console.log(ok ? "NOTICE: up to date" : "NOTICE is out of date: run node tools/notice.js");
    process.exit(ok ? 0 : 1);
  }
  fs.writeFileSync(FILE, now);
  console.log(`NOTICE: ${now.split("\n").filter((l) => l.startsWith("- ")).length} lines`);
}
