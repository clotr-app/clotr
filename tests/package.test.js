// Tests for tools/package.js, which builds the release zips: that they're reproducible, readable, and exactly
// what ships.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { build, crc32, appStoreVersion } = require("../tools/package.js");

const EXT = path.join(__dirname, "..", "extension");

// Reads a stored-only zip back into [name, bytes] pairs, checking each entry's CRC along the way.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, "no end-of-directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, "bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.strictEqual(method, 0, `${name}: not stored`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.strictEqual(crc32(data), crc, `${name}: CRC mismatch`);
    out.push([name, data]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clotr-pkg-test-"));

test("release zip is byte-identical when built twice, and its checksum is recorded", () => {
  const a = build({ outDir: tmp() });
  const b = build({ outDir: tmp() });
  assert.strictEqual(a.sha256, b.sha256);
  assert.ok(fs.readFileSync(a.out).equals(fs.readFileSync(b.out)));
  const sums = fs.readFileSync(path.join(path.dirname(a.out), "SHA256SUMS.txt"), "utf8");
  assert.strictEqual(sums, `${a.sha256}  ${path.basename(a.out)}\n`);
  assert.strictEqual(crypto.createHash("sha256").update(fs.readFileSync(a.out)).digest("hex"), a.sha256);
});

test("a file that vanishes while the zip is built is skipped, not a crash (another test's planted file, removed mid-walk)", () => {
  const vanished = "zz-vanished-mid-walk.js";
  const { readdirSync } = fs;
  fs.readdirSync = function (dir, ...rest) {
    const names = readdirSync.call(fs, dir, ...rest);
    return path.resolve(String(dir)) === path.resolve(EXT) ? [...names, vanished] : names;
  };
  try {
    const out = build({ outDir: tmp() });
    assert.ok(!unzip(fs.readFileSync(out.out)).some(([name]) => name === vanished));
  } finally {
    fs.readdirSync = readdirSync;
  }
});

test("release zip holds exactly the shipped files, sorted, manifest at the root, LF text", () => {
  const r = build({ outDir: tmp() });
  const entries = unzip(fs.readFileSync(r.out));
  const names = entries.map(([n]) => n);
  assert.deepStrictEqual(names, [...names].sort());
  assert.ok(names.includes("manifest.json") && names.includes("content.js") && names.includes("dashboard.html"));
  assert.ok(!names.some((n) => n.startsWith("bravelogs/") || n.endsWith(".log") || n.includes("\\")), names.join());
  for (const [name, data] of entries) {
    if (name === "manifest.json") continue; // trimmed for held-back features: checked below
    const disk = fs.readFileSync(path.join(EXT, ...name.split("/")));
    if (/\.(js|json|html|css|md|txt|svg)$/.test(name)) {
      assert.ok(!data.includes("\r\n"), `${name}: CRLF`);
      assert.strictEqual(data.toString("utf8"), disk.toString("utf8").replace(/\r\n/g, "\n"), `${name} differs`);
    } else {
      assert.ok(data.equals(disk), `${name} differs`);
    }
  }
  // The shipped manifest turns every held-back feature off, so it has no optional permission and no Command
  // check listener.
  const shipped = JSON.parse(entries.find(([n]) => n === "manifest.json")[1].toString("utf8"));
  const disk = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  delete disk.optional_permissions;
  disk.content_scripts = disk.content_scripts.map((c) => ({ ...c, js: c.js.filter((f) => f !== "commands.js") }));
  assert.deepStrictEqual(shipped, disk);
  assert.ok(Object.values(shipped.clotr_features).every((v) => v === false));
});

test("Firefox zip gets the Firefox manifest; checksums of both builds sit side by side", () => {
  const dir = tmp();
  const chrome = build({ outDir: dir });
  const ff = build({ firefox: true, outDir: dir });
  const m = JSON.parse(
    unzip(fs.readFileSync(ff.out))
      .find(([n]) => n === "manifest.json")[1]
      .toString("utf8"),
  );
  assert.deepStrictEqual(m.background, {
    scripts: ["patterns.js", "detector.js", "decide.js", "helper-core.js", "backup.js", "sites.js", "background.js"],
  });
  assert.ok(!m.storage, "Chrome's managed_schema key stays out of the Firefox manifest");
  assert.ok(!m.permissions.includes("declarativeContent"));
  assert.strictEqual(m.browser_specific_settings.gecko.id, "clotr@billiambash");
  const sums = fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.deepStrictEqual(
    sums.sort(),
    [`${chrome.sha256}  ${path.basename(chrome.out)}`, `${ff.sha256}  ${path.basename(ff.out)}`].sort(),
  );
  build({ outDir: dir }); // rebuilding replaces its line instead of adding another
  assert.strictEqual(fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n").length, 2);
});

const zipManifest = (out) =>
  JSON.parse(
    unzip(fs.readFileSync(out))
      .find(([n]) => n === "manifest.json")[1]
      .toString("utf8"),
  );
const sourceManifest = () => JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const BACKGROUND_SCRIPTS = [
  "patterns.js",
  "detector.js",
  "decide.js",
  "helper-core.js",
  "backup.js",
  "sites.js",
  "background.js",
];

// Adding a Safari build must leave the other two builds exactly as they were. The Chrome zip carries the manifest
// as written, and the Firefox manifest is the source manifest with only its five known changes, including the
// Android 142 minimum.
test("Chrome and Firefox builds stay as they were: their manifests, exactly", () => {
  const dir = tmp();
  const source = sourceManifest();
  // Every held-back feature is off in source: no optional permission, and Command check's listener isn't shipped.
  const noHeldBack = { ...source };
  delete noHeldBack.optional_permissions;
  noHeldBack.content_scripts = source.content_scripts.map((c) => ({
    ...c,
    js: c.js.filter((f) => f !== "commands.js"),
  }));
  assert.deepStrictEqual(zipManifest(build({ outDir: dir }).out), noHeldBack);
  const expected = { ...noHeldBack };
  delete expected.storage;
  expected.permissions = source.permissions.filter((p) => p !== "declarativeContent");
  expected.background = { scripts: BACKGROUND_SCRIPTS };
  expected.action = {
    ...source.action,
    theme_icons: [
      { light: "icons/icon-off-16.png", dark: "icons/icon-off-16.png", size: 16 },
      { light: "icons/icon-off-32.png", dark: "icons/icon-off-32.png", size: 32 },
    ],
  };
  expected.browser_specific_settings = {
    gecko: {
      id: "clotr@billiambash",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  };
  assert.deepStrictEqual(zipManifest(build({ firefox: true, outDir: dir }).out), expected);
});

// Builds for Safari on iPhone, iPad and Mac: the same files, but with a Safari manifest. Safari runs a background
// page the way Firefox does, since iPhone only allows a page that can be stopped, and it has neither
// declarativeContent nor managed storage. Safari 17 is the floor because the patterns' lookbehind needs at least
// 16.4, and the site list stays exactly as narrow as elsewhere.
test("Safari build: the Safari manifest, the same files, and a ready folder beside the zip", () => {
  const dir = tmp();
  const chrome = build({ outDir: dir });
  const safari = build({ safari: true, outDir: dir });
  const { version } = sourceManifest();
  assert.strictEqual(path.basename(safari.out), `clotr-${version}-safari.zip`);
  const m = zipManifest(safari.out);
  const source = sourceManifest();
  assert.deepStrictEqual(m.background, { scripts: BACKGROUND_SCRIPTS });
  assert.ok(!m.permissions.includes("declarativeContent"), "Safari has no declarativeContent");
  assert.ok(!m.storage, "Safari has no managed storage, so no managed_schema");
  assert.deepStrictEqual(m.browser_specific_settings, { safari: { strict_min_version: "17.0" } });
  assert.deepStrictEqual(m.host_permissions, source.host_permissions, "the same exact AI-site list");
  // Command check is held back in source: its listener isn't shipped, on any target.
  assert.deepStrictEqual(
    m.content_scripts,
    source.content_scripts.map((c) => ({ ...c, js: c.js.filter((f) => f !== "commands.js") })),
  );
  assert.deepStrictEqual(m.optional_host_permissions, source.optional_host_permissions);
  assert.ok(!("optional_permissions" in m), "Safari has no chrome.management, so no optional_permissions either");
  for (const key of ["version", "name", "action", "icons", "commands", "content_security_policy", "default_locale"])
    assert.deepStrictEqual(m[key], source[key], key);
  // Every file but the manifest is byte for byte the same as the Chrome build's, except the extension-check page,
  // which Safari never ships since it has no chrome.management.
  const chromeFiles = new Map(unzip(fs.readFileSync(chrome.out)));
  const safariFiles = unzip(fs.readFileSync(safari.out));
  const DROPPED = ["extcheck.css", "extcheck.html", "extcheck.js"];
  assert.deepStrictEqual(
    safariFiles.map(([n]) => n),
    [...chromeFiles.keys()].filter((n) => !DROPPED.includes(n)),
  );
  for (const [name, data] of safariFiles)
    if (name !== "manifest.json") assert.ok(data.equals(chromeFiles.get(name)), `${name} differs from Chrome's`);
  // The folder, meant for Apple's packager on a Mac or Safari's "Add Temporary Extension", holds exactly the
  // zip's files.
  assert.strictEqual(safari.folder, path.join(dir, `clotr-${version}-safari`));
  const onDisk = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const file = path.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else onDisk.push(path.relative(safari.folder, file).split(path.sep).join("/"));
    }
  })(safari.folder);
  assert.deepStrictEqual(onDisk.sort(), safariFiles.map(([n]) => n).sort());
  for (const [name, data] of safariFiles)
    assert.ok(fs.readFileSync(path.join(safari.folder, ...name.split("/"))).equals(data), `folder's ${name} differs`);
  // Building Chrome, Firefox and Safari together leaves three checksum lines.
  const ff = build({ firefox: true, outDir: dir });
  assert.deepStrictEqual(
    fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n").sort(),
    [chrome, ff, safari].map((r) => `${r.sha256}  ${path.basename(r.out)}`).sort(),
  );
});

test("Safari build is reproducible, and a rebuild leaves nothing old in its folder", () => {
  const dir = tmp();
  const a = build({ safari: true, outDir: dir });
  fs.writeFileSync(path.join(a.folder, "left-over.txt"), "from an older build\n");
  fs.mkdirSync(path.join(a.folder, "old-dir"));
  const b = build({ safari: true, outDir: dir });
  assert.strictEqual(a.sha256, b.sha256);
  assert.ok(!fs.existsSync(path.join(b.folder, "left-over.txt")), "an old file stayed in the Safari folder");
  assert.ok(!fs.existsSync(path.join(b.folder, "old-dir")), "an old folder stayed in the Safari folder");
  assert.strictEqual(build({ safari: true, outDir: tmp() }).sha256, a.sha256);
});

// Lists the files in a folder as sorted "/" paths.
function filesIn(folder) {
  const found = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const file = path.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else found.push(path.relative(folder, file).split(path.sep).join("/"));
    }
  })(folder);
  return found.sort();
}

// Builds the Firefox folder used for trying the extension (npm run try:firefox): the zip's files, unzipped, with
// the Firefox manifest, and nothing written beside them, since a try never touches a release's zip or checksums.
// Firefox watches the folder while it's open, so a rebuild keeps the folder and rewrites only what changed,
// leaving an untouched file alone.
test("Firefox folder: the zip's files with the Firefox manifest, alone; a rebuild changes only what changed", () => {
  const zipped = build({ firefox: true, outDir: tmp() });
  const out = tmp();
  const folder = path.join(out, "firefox-try");
  const r = build({ firefox: true, folder, zip: false, outDir: out });
  assert.strictEqual(r.folder, folder);
  assert.strictEqual(r.out, undefined, "a folder-only build made a zip");
  assert.deepStrictEqual(fs.readdirSync(out), ["firefox-try"], "a folder-only build wrote beside the folder");
  const files = unzip(fs.readFileSync(zipped.out));
  assert.deepStrictEqual(
    filesIn(folder),
    files.map(([n]) => n),
  );
  for (const [name, data] of files)
    assert.ok(fs.readFileSync(path.join(folder, ...name.split("/"))).equals(data), `folder's ${name} differs`);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).browser_specific_settings.gecko.id,
    "clotr@billiambash",
  );
  assert.deepStrictEqual(r.changed, r.files, "the first build writes every file");

  // After an edit, a rebuild brings back the edited file, removes anything an older build left behind, and leaves
  // the rest untouched.
  const old = new Date("2001-01-01T00:00:00Z");
  fs.utimesSync(path.join(folder, "patterns.js"), old, old);
  fs.writeFileSync(path.join(folder, "content.js"), "// an older content.js\n");
  fs.writeFileSync(path.join(folder, "left-over.txt"), "from an older build\n");
  fs.mkdirSync(path.join(folder, "old-dir"));
  fs.writeFileSync(path.join(folder, "old-dir", "gone.js"), "\n");
  const again = build({ firefox: true, folder, zip: false, outDir: out });
  assert.deepStrictEqual(again.changed, ["content.js", "left-over.txt", "old-dir/gone.js"]);
  assert.deepStrictEqual(
    filesIn(folder),
    files.map(([n]) => n),
  );
  assert.ok(!fs.existsSync(path.join(folder, "old-dir")), "an emptied old folder stayed");
  assert.strictEqual(
    fs.statSync(path.join(folder, "patterns.js")).mtimeMs,
    old.getTime(),
    "an untouched file was rewritten",
  );
  assert.deepStrictEqual(build({ firefox: true, folder, zip: false, outDir: out }).changed, [], "nothing to change");
});

// A try folder's manifest can get one last change, since try-firefox needs Clotr to run on its local practice
// page. A zip never gets that change, so a store or release build always ships the manifest as tested above.
test("Firefox folder: a try's own manifest change lands in the folder, and is refused for a zip", () => {
  const out = tmp();
  const folder = path.join(out, "firefox-try");
  const practice = (m) => {
    m.content_scripts[0].matches.push("http://127.0.0.1/*");
    return m;
  };
  build({ firefox: true, folder, zip: false, outDir: out, manifest: practice });
  const m = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  assert.deepStrictEqual(m.content_scripts[0].matches, [
    ...sourceManifest().content_scripts[0].matches,
    "http://127.0.0.1/*",
  ]);
  assert.throws(() => build({ firefox: true, outDir: tmp(), manifest: practice }), /never goes into a zip/);
});

test("one browser per build: Firefox and Safari together is refused", () => {
  assert.throws(() => build({ firefox: true, safari: true, outDir: tmp() }), /one of/);
});

// App Store Connect only accepts a version with at most three numbers, but a build made between releases has four.
test("App Store versions: three numbers upload, a four-number build is for trying only", () => {
  assert.strictEqual(appStoreVersion("1.3.0"), true);
  assert.strictEqual(appStoreVersion("1.10.2"), true);
  assert.strictEqual(appStoreVersion("1.1.1.4"), false);
  assert.strictEqual(appStoreVersion("1.3"), true);
  assert.strictEqual(appStoreVersion("1.3.0-beta"), false);
});

test("a file git doesn't track (personal notes, a saved chat) never ships", () => {
  const stray = path.join(EXT, "zz-private-notes.txt");
  fs.writeFileSync(stray, "my phone 555-555-0147\n");
  try {
    const r = build({ outDir: tmp() });
    assert.ok(!r.files.includes("zz-private-notes.txt"), "untracked file was packaged");
    assert.ok(!fs.readFileSync(r.out).includes("555-555-0147"), "its contents are in the zip");
  } finally {
    fs.rmSync(stray, { force: true });
  }
});

// Each release carries a software bill of materials (SPDX 2.3) beside its zip, listing every shipped file with its
// checksum, the zip's own SHA-256, the license, and no third-party packages. It's reproducible just like the zip.
test("release SBOM: beside the zip, every shipped file, no third-party packages, byte-identical when rebuilt", () => {
  const a = build({ outDir: tmp() });
  const b = build({ outDir: tmp() });
  assert.strictEqual(path.dirname(a.sbom), path.dirname(a.out));
  assert.strictEqual(path.basename(a.sbom), path.basename(a.out).replace(/\.zip$/, ".spdx.json"));
  assert.ok(fs.readFileSync(a.sbom).equals(fs.readFileSync(b.sbom)), "the SBOM changed between two builds");
  const doc = JSON.parse(fs.readFileSync(a.sbom, "utf8"));
  const { version } = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.strictEqual(doc.spdxVersion, "SPDX-2.3");
  assert.strictEqual(doc.packages.length, 1, "a third-party package in the SBOM");
  const [pkg] = doc.packages;
  assert.strictEqual(pkg.name, "Clotr");
  assert.strictEqual(pkg.versionInfo, version);
  assert.strictEqual(pkg.licenseDeclared, "AGPL-3.0-or-later");
  assert.deepStrictEqual(pkg.checksums, [{ algorithm: "SHA256", checksumValue: a.sha256 }]);
  assert.deepStrictEqual(
    doc.files.map((f) => f.fileName),
    a.files.map((n) => `./${n}`),
  );
  const unzipped = new Map(unzip(fs.readFileSync(a.out)));
  for (const f of doc.files) {
    const sha256 = f.checksums.find((c) => c.algorithm === "SHA256").checksumValue;
    assert.strictEqual(
      sha256,
      crypto
        .createHash("sha256")
        .update(unzipped.get(f.fileName.slice(2)))
        .digest("hex"),
      f.fileName,
    );
  }
  const contains = doc.relationships.filter((r) => r.relationshipType === "CONTAINS");
  assert.strictEqual(contains.length, doc.files.length);
});
