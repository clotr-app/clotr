"use strict";
/* global require, module, __dirname */

const fs = require("node:fs");
const path = require("node:path");

// Guard's lib files as its package.json `files` list names them; none when that file is missing or unreadable.
function guardLibFiles(packageJson) {
  try {
    const files = JSON.parse(fs.readFileSync(packageJson, "utf8")).files;
    if (!Array.isArray(files)) return [];
    // The MCP server's files ship in Guard's npm package, but the extension never runs them.
    return files.filter((file) => file.startsWith("lib/") && !file.startsWith("lib/mcp-server/"));
  } catch {
    return [];
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
    const libFiles = guardLibFiles(path.join(guardSource, "package.json"));
    if (libFiles.length === 0) throw new Error("Guard's package.json lists no lib files to package.");
    for (const dir of ["bin", "lib", "dist"]) fs.mkdirSync(path.join(guardDestination, dir), { recursive: true });
    for (const file of ["bin/clotr-guard.js", ...libFiles, "package.json"]) {
      // Guard's lib files sit in folders, so each one's folder is made first.
      fs.mkdirSync(path.dirname(path.join(guardDestination, file)), { recursive: true });
      fs.copyFileSync(path.join(guardSource, file), path.join(guardDestination, file));
    }
    fs.writeFileSync(path.join(guardDestination, "dist", "clotr-engine.js"), bundle);
    fs.copyFileSync(license, path.join(outDir, "LICENSE"));
    return { bundlePath: path.join(guardDestination, "dist", "clotr-engine.js") };
  }

  const libFiles = guardLibFiles(path.join(guardDestination, "package.json"));
  const required = ["bin/clotr-guard.js", ...libFiles, "package.json", "dist/clotr-engine.js"];
  if (
    libFiles.length > 0 &&
    required.every((file) => fs.existsSync(path.join(guardDestination, file))) &&
    fs.existsSync(path.join(outDir, "LICENSE"))
  ) {
    return { bundlePath: path.join(guardDestination, "dist", "clotr-engine.js") };
  }
  throw new Error("The VS Code package is missing Guard's bundled runtime or the repository license.");
}

if (require.main === module) build();

module.exports = { build, guardLibFiles };
