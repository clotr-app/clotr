"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const vscode = require("vscode");
const { EXTENSION_FOLDER } = require("./bundled-guard.js");

function vscodeEngine({ state }) {
  let host;
  let vmContext;

  // ---------- The engine ----------

  const salt = workspaceSalt();
  if (!startEngine()) return null;
  return { host, checkWithDetection };

  // This workspace's salt for fingerprints, made once and kept in the workspace's state.
  function workspaceSalt() {
    const saved = state.get("salt");
    if (saved) return saved;
    const made = crypto.randomBytes(16).toString("hex");
    void state.update("salt", made);
    return made;
  }
  // Runs the engine bundle in a context of its own and starts it. False when it can't.
  function startEngine() {
    try {
      const bundle = fs.readFileSync(path.join(EXTENSION_FOLDER, "guard", "dist", "clotr-engine.js"), "utf8");
      vmContext = vm.createContext({});
      new vm.Script(bundle).runInContext(vmContext);
      host = vmContext.ClotrHost;
      host.init({ salt, locale: vscode.env.language });
      return true;
    } catch (_error) {
      return false;
    }
  }
  function checkWithDetection(text, options) {
    // host.check already detects this text, so reuse those groups to map its diagnostic ranges.
    const detect = vmContext.Clotr.detect;
    let groups;
    vmContext.Clotr.detect = (value) => {
      const detected = detect(value);
      if (value === text) groups = detected;
      return detected;
    };
    try {
      return { checked: host.check(text, options), groups };
    } finally {
      vmContext.Clotr.detect = detect;
    }
  }
}

module.exports = { vscodeEngine };
