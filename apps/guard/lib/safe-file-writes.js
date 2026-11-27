"use strict";
/* global Buffer, require, module, process */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { MAX_SETTINGS_BYTES } = require("./limits-and-messages.js");

function removeFile(file, force = false) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!force || error.code !== "ENOENT") throw error;
  }
}

function atomicWriteFile(file, contents, options = {}) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, contents, { ...options, flag: "wx" });
    if (options.mode !== undefined) fs.chmodSync(temporary, options.mode & 0o777);
    fs.renameSync(temporary, file);
  } catch (error) {
    removeFile(temporary, true);
    throw error;
  }
}

function readConfigFile(file, maxBytes = MAX_SETTINGS_BYTES) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("unsafe-settings-file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes || (before.ino && opened.ino && before.ino !== opened.ino)) {
      throw new Error("unsafe-settings-file");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) throw new Error("unsafe-settings-file");
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)), stat: opened };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(root, target) {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("settings-path-outside-root");
  }
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("settings-symbolic-link");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// Whether `candidate` is `root` or inside it, both resolved first.
function pathInside(root, candidate) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

module.exports = { removeFile, atomicWriteFile, readConfigFile, assertNoSymlinkComponents, pathInside };
