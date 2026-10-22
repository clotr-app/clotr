"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "apps", "guard", "lib", "secret-files.js");
const outputPath = path.join(root, "apps", "jetbrains", "src", "main", "resources", "secret-files.json");

function capture(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not read ${label} from the shared secret-file rules`);
  return match[1];
}

function strings(source, pattern, label) {
  return [...capture(source, pattern, label).matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function generate() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const opensshPrivateKeys = strings(
    source,
    /const OPENSSH_PRIVATE_KEYS = new Set\(([\s\S]*?)\);/,
    "private key names",
  );
  const environmentExamples = strings(source, /const ENV_EXAMPLES = new Set\(([\s\S]*?)\);/, "environment examples");
  const exactNames = strings(
    source,
    /OPENSSH_PRIVATE_KEYS\.has\(name\)\s*\|\|\s*\[([\s\S]*?)\]\.includes\(name\)/,
    "secret file names",
  );
  const secretPaths = strings(source, /const SECRET_PATHS = \[([\s\S]*?)\];/, "secret file paths");
  const extensionsRule = capture(source, /if \((\/\\\.\(\?:[^\n]+?\/)i\.test\(name\)\)/, "secret file extensions");
  const extensions = new RegExp(extensionsRule.slice(1, extensionsRule.lastIndexOf("/"))).source;
  const serviceAccount = capture(source, /return (\/[^\n]+?\/)\.test\(content\);/, "service account rule");
  const markerPattern = serviceAccount.slice(1, serviceAccount.lastIndexOf("/")).replaceAll('"', "\\x22");
  const serviceAccountMarker = new RegExp(markerPattern).source;
  return `${JSON.stringify(
    {
      opensshPrivateKeys,
      environmentExamples,
      exactNames,
      secretPaths,
      extensions: [extensions],
      serviceAccountMarker: [serviceAccountMarker],
    },
    null,
    2,
  )}\n`;
}

const expected = generate();
if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== expected) {
    console.error("JetBrains secret-files.json is stale. Run node tools/sync-secret-files.js.");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, expected);
}
