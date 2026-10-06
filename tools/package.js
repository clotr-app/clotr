// Builds dist/clotr-<version>.zip from extension/, for a GitHub release or a store upload, and records its
// SHA-256 in dist/SHA256SUMS.txt. It leaves out the user's saved logs (bravelogs/) and anything that isn't
// shipped.
//
// Usage: npm run package              Chrome, Brave, Edge
//        npm run package -- --firefox  Firefox desktop and Android, same code, a Firefox manifest
//        npm run package -- --safari   Safari on iPhone, iPad and Mac, same code, a Safari manifest
//        --out <dir>                   build somewhere other than dist/
//        --folder <dir>                also write the same files, unzipped, to <dir>, e.g. to load in Firefox by hand
//
// The Safari build also writes its files, unzipped, to dist/clotr-<version>-safari/. App Store Connect's
// Safari packager takes the zip and needs no Mac; a Mac takes the folder, either through `xcrun
// safari-web-extension-packager --copy-resources <folder>` or Safari's Develop menu for a quick try.
//
// The build is reproducible: the same source gives a byte-identical zip on any computer, so anyone can
// rebuild a release and compare checksums. I sort the files, fix their timestamps, normalize text line
// endings to LF, and store entries uncompressed, since compressed bytes can differ between zlib versions and
// the extension is small enough that it doesn't matter.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const SKIP = new Set(["bravelogs", ".DS_Store", "Thumbs.db", "desktop.ini"]);
const TEXT = new Set([".js", ".json", ".html", ".css", ".md", ".txt", ".svg"]);
// 1980-01-01 00:00, the earliest time a zip can hold.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// In a service worker, background.js loads these itself with importScripts. Firefox and Safari run a
// background page instead, so I give it the same list directly, in the same order.
const BACKGROUND_SCRIPTS = [
  "patterns.js",
  "detector.js",
  "decide.js",
  "helper-core.js",
  "backup.js",
  "sites.js",
  "background.js",
];

// Firefox runs background scripts instead of a service worker and has no declarativeContent. It also needs
// an add-on ID and a data-collection declaration, which here says none.
function firefoxManifest(m) {
  m.background = { scripts: BACKGROUND_SCRIPTS.slice() };
  delete m.storage; // managed_schema is a Chrome thing; Firefox reads its policy from policies.json instead
  m.permissions = m.permissions.filter((p) => p !== "declarativeContent");
  // The bandage's tape and keyline already read fine on a light or dark toolbar, so both entries point at
  // the same file. This just satisfies Firefox's theme_icons schema; there's no separate dark drawing.
  m.action.theme_icons = [
    { light: "icons/icon-off-16.png", dark: "icons/icon-off-16.png", size: 16 },
    { light: "icons/icon-off-32.png", dark: "icons/icon-off-32.png", size: 32 },
  ];
  m.browser_specific_settings = {
    gecko: {
      id: "clotr@billiambash",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  };
  return m;
}

// Safari, on iPhone, iPad and Mac, runs the same background page as Firefox. In this manifest version
// Safari may stop it when idle, which is the only kind of background iPhone allows. It has no
// declarativeContent and no managed storage, so both go. Safari 17 is the floor, since the patterns'
// lookbehind needs 16.4 and session storage arrived in the same release. The site lists stay exactly as
// written.
function safariManifest(m) {
  m.background = { scripts: BACKGROUND_SCRIPTS.slice() };
  delete m.storage; // there's nothing for managed_schema to read on Safari; background.js only asks for it if it exists
  m.permissions = m.permissions.filter((p) => p !== "declarativeContent");
  // management isn't an API on Safari, and it's the only reason Extension check needs a permission at all.
  delete m.optional_permissions;
  m.browser_specific_settings = { safari: { strict_min_version: "17.0" } };
  return m;
}

// The manifest each browser gets, from the one in extension/.
const MANIFEST_FOR = { chrome: (m) => m, firefox: firefoxManifest, safari: safariManifest };

// Files a target doesn't ship at all, beyond what its manifest already leaves unreferenced. Safari has no
// chrome.management, so Extension check's page never ships there regardless of the flag below.
const DROP_FOR = {
  safari: new Set(["extcheck.html", "extcheck.css", "extcheck.js", "extcheck-core.js", "reported-extensions.js"]),
};

// Each held-back feature's own files, keyed by its name in extension/manifest.json's clotr_features. They're
// dropped from the package while the feature is off, though nothing is removed from the source tree itself;
// a later release can ship one just by flipping its flag. practice-data.js is shared by Practice and Office
// training, so I handle it separately below.
const FEATURE_FILES = {
  tourniquet: [],
  lookback: [
    "lookback.html",
    "lookback.css",
    "lookback.js",
    "lookback-core.js",
    "lookback-worker.js",
    "letter.js",
    "zip.js",
    "scan-words.js",
  ],
  extcheck: ["extcheck.html", "extcheck.css", "extcheck.js", "extcheck-core.js", "reported-extensions.js"],
  scamcheck: ["check.html", "check.css", "check.js", "scam-signs.js"],
  commandcheck: ["commands.js"],
  practice: ["practice.html", "practice.css", "practice.js"],
  training: ["training.html", "training.css", "training.js", "training-data.js"],
};

// A couple of held-back features also need something removed from the manifest itself, not just their own
// files. Command check's copy listener is a content script, so there's nothing to toggle at runtime once
// it isn't shipped. And since Extension check is the only reason the optional `management` permission
// exists, that comes out too when the feature is off.
function featureManifest(m, features) {
  m = { ...m, clotr_features: features };
  if (!features.commandcheck)
    m.content_scripts = m.content_scripts.map((c) => ({ ...c, js: c.js.filter((f) => f !== "commands.js") }));
  if (!features.extcheck) {
    m.optional_permissions = (m.optional_permissions || []).filter((p) => p !== "management");
    if (!m.optional_permissions.length) delete m.optional_permissions;
  }
  return m;
}

// App Store Connect only takes a version with one to three numbers. A build between releases has a fourth
// number, which is fine to try on a Mac but can't be uploaded.
const appStoreVersion = (version) => /^\d+(\.\d+){0,2}$/.test(version);

// The files git tracks under extension/, or null outside a git checkout. Only tracked files ship, so a
// stray personal file in the folder, like a note, a saved chat or an editor backup, never reaches a release.
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "extension"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split(String.fromCharCode(0))
        .filter(Boolean)
        .map((f) => f.slice("extension/".length)),
    );
  } catch {
    return null;
  }
}

// Every shipped file as [zip path, bytes], sorted by path.
function collect(target, features) {
  const tracked = trackedFiles();
  if (!tracked)
    console.warn("[package] not a git checkout: packaging every file in extension/ (check it has nothing personal)");
  const drop = new Set(DROP_FOR[target] || []);
  for (const [name, on] of Object.entries(features)) if (!on) for (const f of FEATURE_FILES[name] || []) drop.add(f);
  if (!features.practice && !features.training) drop.add("practice-data.js");
  const entries = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name) || name.endsWith(".log")) continue;
      const file = path.join(dir, name);
      // It's fine if the file disappeared mid-walk, like another test's throwaway file; there's nothing to package.
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      const rel = path.relative(EXT, file).split(path.sep).join("/");
      if (tracked && !tracked.has(rel)) continue;
      if (drop.has(rel)) continue;
      let data = fs.readFileSync(file);
      if (TEXT.has(path.extname(name).toLowerCase()))
        data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      if (rel === "manifest.json") {
        let m = featureManifest(JSON.parse(data.toString("utf8")), features);
        if (target !== "chrome") m = MANIFEST_FOR[target](m);
        data = Buffer.from(`${JSON.stringify(m, null, 2)}\n`, "utf8");
      }
      entries.push([rel, data]);
    }
  })(EXT);
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A plain zip: stored entries, UTF-8 names, no extra fields.
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all 0
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

// Replace (or add) this zip's line in SHA256SUMS.txt, in `sha256sum` format.
function recordChecksum(outDir, fileName, hash) {
  const sums = path.join(outDir, "SHA256SUMS.txt");
  const lines = fs.existsSync(sums)
    ? fs
        .readFileSync(sums, "utf8")
        .split("\n")
        .filter((l) => l && !l.endsWith(`  ${fileName}`))
    : [];
  lines.push(`${hash}  ${fileName}`);
  fs.writeFileSync(sums, `${lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
}

// Writes the release's software bill of materials, SPDX 2.3 JSON next to the zip. It describes the
// extension as one package, with its version, license and the zip's SHA-256, containing every shipped file
// and its checksums. There are no other packages, since the extension ships no third-party code. Like the
// zip, it's reproducible: the same fixed time, sorted files, no random ids.
function sbom({ fileName, version, sha256, entries }) {
  const hash = (algo, data) => crypto.createHash(algo).update(data).digest("hex");
  const files = entries.map(([name, data], i) => ({
    fileName: `./${name}`,
    SPDXID: `SPDXRef-File-${i + 1}`,
    checksums: [
      { algorithm: "SHA1", checksumValue: hash("sha1", data) },
      { algorithm: "SHA256", checksumValue: hash("sha256", data) },
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
  // SPDX's package verification code is the SHA-1 of the files' SHA-1s, sorted and joined.
  const verification = hash(
    "sha1",
    files
      .map((f) => f.checksums[0].checksumValue)
      .sort()
      .join(""),
  );
  const doc = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: fileName,
    documentNamespace: `https://github.com/clotr-app/clotr/releases/${fileName}/${sha256}`,
    creationInfo: { created: "1980-01-01T00:00:00Z", creators: ["Tool: clotr-tools-package"] },
    packages: [
      {
        name: "Clotr",
        SPDXID: "SPDXRef-Package-Clotr",
        versionInfo: version,
        packageFileName: fileName,
        downloadLocation: "https://github.com/clotr-app/clotr/releases",
        filesAnalyzed: true,
        packageVerificationCode: { packageVerificationCodeValue: verification },
        checksums: [{ algorithm: "SHA256", checksumValue: sha256 }],
        licenseConcluded: "AGPL-3.0-or-later",
        licenseDeclared: "AGPL-3.0-or-later",
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: "APPLICATION",
        comment: "A browser extension. It ships no third-party packages and no AI model.",
      },
    ],
    files,
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package-Clotr" },
      ...files.map((f) => ({
        spdxElementId: "SPDXRef-Package-Clotr",
        relationshipType: "CONTAINS",
        relatedSpdxElement: f.SPDXID,
      })),
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// Writes the build's files, unzipped, into a folder, so the folder ends up holding exactly them: anything an
// earlier build left there goes, and only files whose bytes actually changed get written. The folder itself
// stays in place, so a browser watching it (npm run try:firefox) only sees the files that changed. It
// returns those changed or removed files as sorted "/" paths.
function writeFolder(folder, entries) {
  const wanted = new Map(entries);
  const changed = [];
  (function prune(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) {
        prune(file);
        if (!fs.readdirSync(file).length) fs.rmdirSync(file);
        continue;
      }
      const rel = path.relative(folder, file).split(path.sep).join("/");
      if (!wanted.has(rel)) {
        fs.rmSync(file, { force: true });
        changed.push(rel);
      }
    }
  })(folder);
  for (const [name, data] of entries) {
    const file = path.join(folder, ...name.split("/"));
    if (fs.existsSync(file) && fs.readFileSync(file).equals(data)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    changed.push(name);
  }
  return changed.sort();
}

// folder: also write the files there, unzipped; the Safari build always does this beside its zip.
// zip: pass false to skip the zip, its checksum and the bill of materials and just get the folder, so a
//   quick try never touches a real release's files.
// manifest: a function that makes one last change to the built manifest, for a folder you're trying
//   locally only; a zip always ships the manifest exactly as built.
// features: overrides extension/manifest.json's clotr_features for this build only, so the browser suite
//   can build with every held-back feature turned on and test them.
function build({
  firefox = false,
  safari = false,
  outDir = path.join(ROOT, "dist"),
  folder,
  zip: makeZip = true,
  manifest,
  features: featureOverrides,
} = {}) {
  if (firefox && safari) throw new Error("build one of Chrome, Firefox or Safari at a time");
  if (manifest && makeZip) throw new Error("a changed manifest is only for a folder to try: it never goes into a zip");
  const target = firefox ? "firefox" : safari ? "safari" : "chrome";
  const raw = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const { version } = raw;
  const features = { ...raw.clotr_features, ...featureOverrides };
  const entries = collect(target, features);
  if (manifest) {
    const i = entries.findIndex(([n]) => n === "manifest.json");
    const changedManifest = manifest(JSON.parse(entries[i][1].toString("utf8")));
    entries[i] = ["manifest.json", Buffer.from(`${JSON.stringify(changedManifest, null, 2)}\n`, "utf8")];
  }
  // Every file the built manifest names must be in the zip. A new file git doesn't track yet would be
  // left out (only tracked files ship) and the extension would break at load.
  const m = JSON.parse(entries.find(([n]) => n === "manifest.json")[1].toString("utf8"));
  const needed = [
    m.background?.service_worker,
    ...(m.background?.scripts || []),
    m.action?.default_popup,
    m.storage?.managed_schema,
    ...(m.content_scripts || []).flatMap((c) => c.js),
    ...Object.values(m.icons || {}),
    ...Object.values(m.action?.default_icon || {}),
  ].filter(Boolean);
  const shipped = new Set(entries.map(([n]) => n));
  const missing = needed.filter((f) => !shipped.has(f));
  if (missing.length)
    throw new Error(
      `the manifest uses files that aren't in the zip: ${missing.join(", ")} (new files must be added to git)`,
    );
  const fileName = `clotr-${version}${target === "chrome" ? "" : `-${target}`}.zip`;
  if (safari && !folder) folder = path.join(outDir, fileName.replace(/\.zip$/, ""));
  const changed = folder ? writeFolder(folder, entries) : undefined;
  const files = entries.map(([n]) => n);
  if (!makeZip) return { folder, changed, files, version, manifest: m, features };
  const bytes = zip(entries);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, fileName);
  fs.writeFileSync(out, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  recordChecksum(outDir, fileName, sha256);
  const sbomOut = path.join(outDir, fileName.replace(/\.zip$/, ".spdx.json"));
  fs.writeFileSync(sbomOut, sbom({ fileName, version, sha256, entries }));
  return { out, sbom: sbomOut, folder, changed, files, size: bytes.length, sha256, version, manifest: m, features };
}

module.exports = {
  build,
  writeFolder,
  crc32,
  zip,
  appStoreVersion,
  firefoxManifest,
  safariManifest,
  featureManifest,
  BACKGROUND_SCRIPTS,
  DROP_FOR,
  FEATURE_FILES,
};

if (require.main === module) {
  const i = process.argv.indexOf("--out");
  const f = process.argv.indexOf("--folder");
  const ft = process.argv.indexOf("--features");
  const safari = process.argv.includes("--safari");
  const noZip = process.argv.includes("--no-zip");
  // --features all-on turns every held-back feature on, for the browser suite's all-on build (npm run test:e2e:all-on).
  const allOn = ft > 0 && process.argv[ft + 1] === "all-on";
  const r = build({
    firefox: process.argv.includes("--firefox"),
    safari,
    outDir: i > 0 ? path.resolve(process.argv[i + 1]) : undefined,
    folder: f > 0 ? path.resolve(process.argv[f + 1]) : undefined,
    zip: !noZip,
    features: allOn ? Object.fromEntries(Object.keys(FEATURE_FILES).map((k) => [k, true])) : undefined,
  });
  if (noZip) {
    console.log(`${path.relative(ROOT, r.folder)}: ${r.files.length} files (features: ${JSON.stringify(r.features)})`);
  } else {
    console.log(`${path.relative(ROOT, r.out)}: ${r.files.length} files, ${(r.size / 1024).toFixed(0)} KB`);
    if (r.folder) {
      console.log(`The same files, unzipped${safari ? " (for a Mac)" : ""}: ${path.relative(ROOT, r.folder)}`);
      if (safari && !appStoreVersion(r.version))
        console.log(
          `Version ${r.version} has four numbers: fine to try on a Mac; App Store Connect takes a release's three.`,
        );
    }
    console.log(
      `SHA-256 ${r.sha256} (also in ${path.relative(ROOT, path.join(path.dirname(r.out), "SHA256SUMS.txt"))})`,
    );
    console.log(`Software bill of materials: ${path.relative(ROOT, r.sbom)}`);
  }
}
