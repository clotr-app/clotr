"use strict";
/* global require, module, process */

const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");
const { SEARCH_WALK_MAX_ENTRIES, SHELL_DRIVE_PATH_MAX_MS } = require("../limits-and-messages.js");

// ---------- Drive top folders ----------

// The names in a drive's folder, false when the drive or folder isn't there, and null when it can't be
// listed: an error, more than SEARCH_WALK_MAX_ENTRIES names, or no answer in time. The listing gets half the
// drive paths' time that's left (SHELL_DRIVE_PATH_MAX_MS), so the rest of the check still fits in that
// second. A shell check lists each folder once and keeps the answer in its budget, however many words or
// passes name it.
function driveTopNames(folder, budget) {
  const key = folder.toLowerCase();
  if (budget?.driveTops?.has(key)) return budget.driveTops.get(key);
  if (budget) budget.lookups -= 1;
  const left = budget ? Math.min(budget.drivePathDeadline, budget.checkDeadline) - Date.now() : SHELL_DRIVE_PATH_MAX_MS;
  const listed = driveTopLister.list(folder, Math.floor(left / 2), SEARCH_WALK_MAX_ENTRIES);
  let names = null;
  if (Array.isArray(listed.names) && listed.names.length <= SEARCH_WALK_MAX_ENTRIES) names = listed.names;
  else if (["ENOENT", "ENOTDIR"].includes(listed.code)) names = false;
  if (budget) {
    if (!budget.driveTops) budget.driveTops = new Map();
    budget.driveTops.set(key, names);
  }
  return names;
}

// A drive's folder is listed by a child process, which a worker thread starts and reads, while this thread
// waits for the answer with a time limit. A mapped drive that never answers holds only that child, which is
// then ended, so the hook still answers in time and exits. A listing on this thread, or on the worker's,
// can't be cut short, and a thread stuck in one keeps the process from exiting. The child prints up to `max +
// 1` names, so a bigger folder is seen as too big, or the error's code.
const DRIVE_TOP_CHILD = `let out;
try {
  out = { names: require("fs").readdirSync(process.argv[1]).slice(0, Number(process.argv[2]) + 1) };
} catch (error) {
  out = { code: String(error.code || "EIO") };
}
process.stdout.write(JSON.stringify(out));`;

const DRIVE_TOP_WORKER = `const { workerData } = require("worker_threads");
const { spawn } = require("child_process");
const { port, flag, folder, max, script } = workerData;
const finish = (out) => {
  port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
};
let text = "";
try {
  const child = spawn(process.execPath, ["-e", script, folder, String(max)], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  port.postMessage({ pid: child.pid });
  child.on("error", () => finish({ code: "EIO" }));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stdout.on("end", () => {
    try {
      finish(JSON.parse(text));
    } catch {
      finish({ code: "EIO" });
    }
  });
} catch {
  finish({ code: "EIO" });
}`;

// Gives { names }, { code } for an error, or { late: true } when no answer came within `ms`.
function listDriveTopApart(folder, ms, max) {
  if (!(ms > 0)) return { late: true };
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker;
  try {
    worker = new Worker(DRIVE_TOP_WORKER, {
      eval: true,
      workerData: { port: port2, flag, folder, max, script: DRIVE_TOP_CHILD },
      transferList: [port2],
    });
  } catch {
    port1.close();
    return { code: "EIO" };
  }
  worker.unref();
  Atomics.wait(flag, 0, 0, ms);
  let answer = { late: true };
  let pid;
  for (let message = receiveMessageOnPort(port1); message; message = receiveMessageOnPort(port1)) {
    if ("pid" in message.message) pid = message.message.pid;
    else answer = message.message;
  }
  if (answer.late && pid) {
    try {
      process.kill(pid);
    } catch {
      // The child has already ended.
    }
  }
  port1.close();
  worker.terminate().catch(() => {});
  return answer;
}

// Kept on an object so a test can list a mocked disk on this thread instead.
const driveTopLister = { list: listDriveTopApart };

module.exports = {
  driveTopNames,
  driveTopLister,
};
