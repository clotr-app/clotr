"use strict";
/* global require, module, process */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { HOOK_CHECK_MAX_MS } = require("../limits-and-messages.js");

// ---------- Network mounts ----------

// File systems whose folders live on another computer (Linux's names, as /proc/self/mountinfo gives them). A
// look at one waits on that computer, and one that stopped answering holds it with no end.
const FUSE_NETWORK_FILE_SYSTEMS = "fuse\\.(?:sshfs|rclone|davfs2?|s3fs|gcsfuse|glusterfs|ceph|curlftpfs)";
const NETWORK_FILE_SYSTEMS = new RegExp(
  `^(?:nfs4?|cifs|smb3?|smbfs|ncpfs|afs|9p|ceph|lustre|glusterfs|gpfs|davfs|${FUSE_NETWORK_FILE_SYSTEMS})$`,
);

// This process's mount table, read once: /proc is answered by the kernel, never by another computer.
let mountTable;
function readMountTable() {
  if (mountTable === undefined) {
    try {
      mountTable = process.platform === "linux" ? fs.readFileSync("/proc/self/mountinfo", "utf8") : "";
    } catch {
      mountTable = "";
    }
  }
  return mountTable;
}

// The mount table's points and file system types, in table order. Split once per table, so a hook that asks
// about many paths splits a big table once.
let parsedTable;
let parsedMounts = [];
function mountsOf(table) {
  if (table !== parsedTable) {
    parsedMounts = [];
    for (const line of table.split("\n")) {
      const fields = line.split(" ");
      const dash = fields.indexOf("-");
      if (dash < 6 || fields.length < dash + 2) continue;
      const point = fields[4].replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
      parsedMounts.push({ point, type: fields[dash + 1] });
    }
    parsedTable = table;
  }
  return parsedMounts;
}

// The network mount `target` is on, as { point, type } (see NETWORK_FILE_SYSTEMS), or null. The path is
// resolved by its text only: following its links would be a look at the disk. The deepest mount holding it
// counts.
function networkMountPointOf(target, table = readMountTable()) {
  if (!table) return null;
  const full = path.posix.resolve(String(target));
  let best = null;
  for (const mount of mountsOf(table)) {
    const { point } = mount;
    const inside = full === point || point === "/" || full.startsWith(`${point}/`);
    if (inside && (!best || point.length >= best.point.length)) best = mount;
  }
  return best && NETWORK_FILE_SYSTEMS.test(best.type) ? best : null;
}

// The network file system `target` is on, or null (see networkMountPointOf).
function networkMountOf(target, table) {
  return networkMountPointOf(target, table)?.type || null;
}

// Whether a look at a network path ends before `deadline`: a folder listed or a file opened, in a child
// process that can be ended, as Git calls are. A path that isn't there answers too. Half the time left goes
// to the look, so the check still has time after a slow one.
function networkPathAnswers(target, deadline) {
  const left = Math.min(deadline ?? Infinity, Date.now() + HOOK_CHECK_MAX_MS) - Date.now();
  if (left <= 0) return false;
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      'const fs=require("fs");const p=process.argv[1];try{fs.statSync(p).isDirectory()?fs.readdirSync(p):fs.closeSync(fs.openSync(p,"r"))}catch{}',
      target,
    ],
    { timeout: Math.max(1, Math.floor(left / 2)), killSignal: "SIGKILL", stdio: "ignore", windowsHide: true },
  );
  return !probe.error && probe.signal === null;
}

module.exports = {
  NETWORK_FILE_SYSTEMS,
  networkMountPointOf,
  networkMountOf,
  networkPathAnswers,
};
