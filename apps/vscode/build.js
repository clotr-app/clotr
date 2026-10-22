"use strict";
/* global require, module, __dirname */

const fs = require("node:fs");
const path = require("node:path");

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function build({ outDir = __dirname, repoRoot = path.resolve(__dirname, "../..") } = {}) {
  const guardSource = path.join(repoRoot, "apps", "guard");
  const bundleTool = path.join(repoRoot, "tools", "engine-bundle.js");
  const guardDestination = path.join(outDir, "guard");

  if (fs.existsSync(guardSource) && fs.existsSync(bundleTool)) {
    const license = path.join(repoRoot, "LICENSE");
    if (!fs.existsSync(license)) throw new Error("The repository LICENSE is required to package VS Code.");
    const { build: buildEngine } = require(bundleTool);
    const bundle = buildEngine().text;
    fs.rmSync(guardDestination, { recursive: true, force: true });
    fs.mkdirSync(path.join(guardDestination, "bin"), { recursive: true });
    fs.mkdirSync(path.join(guardDestination, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(guardSource, "bin", "clotr-guard.js"),
      path.join(guardDestination, "bin", "clotr-guard.js"),
    );
    copyDirectory(path.join(guardSource, "lib"), path.join(guardDestination, "lib"));
    fs.copyFileSync(path.join(guardSource, "package.json"), path.join(guardDestination, "package.json"));
    fs.writeFileSync(path.join(guardDestination, "dist", "clotr-engine.js"), bundle);
    fs.copyFileSync(license, path.join(outDir, "LICENSE"));
    return { bundlePath: path.join(guardDestination, "dist", "clotr-engine.js") };
  }

  const required = [
    "bin/clotr-guard.js",
    "lib/engine.js",
    "lib/secret-files.js",
    "package.json",
    "dist/clotr-engine.js",
  ];
  if (
    required.every((file) => fs.existsSync(path.join(guardDestination, file))) &&
    fs.existsSync(path.join(outDir, "LICENSE"))
  ) {
    return { bundlePath: path.join(guardDestination, "dist", "clotr-engine.js") };
  }
  throw new Error("The VS Code package is missing Guard's bundled runtime or the repository license.");
}

if (require.main === module) build();

module.exports = { build };
