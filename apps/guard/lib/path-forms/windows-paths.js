"use strict";
/* global require, module, process */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { lookupsSpent, ShellCheckTooLong, checkShellDeadline } = require("../check-budget.js");

// ---------- Remote and mounted paths ----------

// A path on another computer or a Windows device path: `\\host\share`, `//host/share`, `\\?\`, `\\.\`,
// `\??\`, or a `file:` URL. To look one up, Windows connects to the host, and the connection can hand that
// host the user's sign-in hash. So Guard judges these paths by name alone, and never looks them up, lists
// them, or runs Git or ripgrep in one. `/net/<host>/...` is the same on macOS, and on Linux with autofs:
// looking one up mounts that host's shares.
const NETWORK_PATH = /^\s*['"]?(?:[\\/]{2}|[\\/]\?\?[\\/]|file:)/i;
const AUTOMOUNT_PATH = /^\s*['"]?\/net(?:\/|$)/i;
// Where macOS mounts other disks and file shares, which another computer often serves (see onMountedVolume).
const VOLUME_PATH = /^\s*['"]?\/volumes(?:\/|$)/i;

// Whether a path starting with `/` sits under the root `pattern` names, as written or tidied:
// `/tmp/../net/host` and `/./net/host` reach /net/host too. (The letter case is ignored, as macOS's own disks
// ignore it.)
function underRoot(pattern, value) {
  if (typeof value !== "string") return false;
  if (pattern.test(value)) return true;
  const written = value.replace(/^\s*['"]?/, "");
  return written.startsWith("/") && pattern.test(path.posix.normalize(written));
}

function isRemotePath(value) {
  if (typeof value !== "string") return false;
  return NETWORK_PATH.test(value) || underRoot(AUTOMOUNT_PATH, value);
}

// Whether a path, or the folder a relative one sits in, passes `test`.
function locationIs(test, value, cwd) {
  if (test(value)) return true;
  if (typeof value !== "string" || typeof cwd !== "string") return false;
  if (!path.isAbsolute(value) && test(cwd)) return true;
  return test(path.resolve(cwd, value));
}

// Whether a path, or the folder a relative one sits in, is one Guard must not touch (see isRemotePath).
function remoteLocation(value, cwd = process.cwd()) {
  // A path on a Windows drive is on this computer, whatever folder it's named from (elsewhere it's a relative
  // path).
  if (process.platform === "win32" && typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value)) return false;
  return locationIs(isRemotePath, value, cwd);
}

// Whether a path is under /Volumes. is_secret_file promises no network calls, so it judges these by name; the
// read hook still opens one to check its text, as Guard does on any disk the computer already has mounted.
function onMountedVolume(value, cwd = process.cwd()) {
  return locationIs((location) => underRoot(VOLUME_PATH, location), value, cwd);
}

function isDirectoryTarget(value, cwd) {
  if (typeof value !== "string" || !value || remoteLocation(value, cwd)) return false;
  try {
    const absolutePath = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });
    return Boolean(stats?.isDirectory());
  } catch {
    return false;
  }
}

// ---------- Path parts as Windows opens them ----------

// `text` without the characters in `chars` at its end. Done without a `$`-anchored expression, which is tried
// from every place in the text and made a long run of blank space in a command take seconds.
function trimEndOf(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

// One part of a path without a stream name: "ENV~1::$DATA" (any "name:stream") opens "ENV~1", and "a:hidden"
// opens a stream of "a". A drive (`C:`, `C:.`) is left as it is, and so is an IPv6 address, a share's host
// (`\\?\UNC\::1\C$`, `[::1]`): a file name written that way, with no `$` type, opens nothing.
function withoutStream(part) {
  const colon = part.indexOf(":");
  if (colon < 0) return part;
  if (/^[A-Za-z]:[. ]*$/.test(part)) return part;
  if (/^\[?(?:[0-9A-Fa-f.]*:){2,}[0-9A-Fa-f.]*(?:%[^\]]*)?\]?$/.test(part)) return part;
  return part.slice(0, colon);
}

// Path parts, `.` and `..` resolved, read as written and as Windows tidies them: a stream name dropped, a
// part's one last dot, and the last part's dots and spaces (see localDevicePaths). Empty parts are left out.
// With `literal`, `.` and `..` are kept as they are; with `streams`, stream names are too.
function windowsReadings(parts, { literal = false, streams = false } = {}) {
  const strip = streams ? (part) => part : withoutStream;
  const resolved = [];
  for (const part of parts) {
    if (!part || (part === "." && !literal)) continue;
    if (part === ".." && !literal) resolved.pop();
    else resolved.push(part);
  }
  const asWritten = resolved.map(strip);
  const lastIndex = resolved.length - 1;
  const tidied = resolved.map((part, index) => tidiedPart(part, strip, index === lastIndex));
  return [asWritten.filter(Boolean), tidied.filter(Boolean)];
}

// One part as Windows tidies it: the last part loses all its last dots and spaces, any other its one last
// dot.
function tidiedPart(part, strip, isLast) {
  if (part === "." || part === "..") return part;
  const opened = strip(part);
  if (isLast) return trimEndOf(opened, ". ");
  if (opened.endsWith(".") && !opened.endsWith("..")) return opened.slice(0, -1);
  return opened;
}

// ---------- Device paths ----------

// The start of a Windows device path, `\\?\`, `\\.\` or `\??\`, either slash, and doubled as a string in a
// script writes them (`\\\\.\\C:`).
const DEVICE_PATH_START = /^\s*['"]?(?:[\\/]{2,}[?.]|[\\/]+\?\?)[\\/]+/;
// The start of a device path whose root Windows opens as written, `\\?\` or `\??\` (see DEVICE_PATH_START).
const EXACT_DEVICE_PATH_START = /^\s*['"]?(?:[\\/]{2,}\?|[\\/]+\?\?)[\\/]/;

// The drive paths a Windows device path to a file on a drive could open, or null for any other path:
// `C:\proj\.env` for `\\?\C:\proj\.env`, `\\.\C:\proj\.env` or `\??\C:\proj\.env`, and for
// `\\.\GLOBALROOT\??\C:\...` or `\\?\Global\C:\...`, other names for the device root. `\\?\` opens each part
// as written, and `\\.\` as Windows tidies it (a part's one last dot dropped, as in `C:.` or `k.`, and the
// last part's dots and spaces), so both readings are given, and a path is a secret file when either is. `.`
// and `..` are resolved, even past the drive, so `\\.\C:\..\UNC\host\share` is no drive path. isRemotePath
// still holds for the device path itself; the secret-file checks (isSecretPath, isSecretOperand) judge these
// drive paths in its place, so a short name or a link behind it is seen.
function localDevicePaths(value) {
  const drives = [];
  for (const [first = "", ...rest] of devicePathReadings(value) || []) {
    const drive = `${first}\\${rest.join("\\")}`;
    if (/^[A-Za-z]:$/.test(first) && !drives.includes(drive)) drives.push(drive);
  }
  return drives.length ? drives : null;
}

// The parts below the device root a Windows device path opens, as written and as Windows tidies them, with
// `.` and `..` resolved and the device root's other names dropped (see localDevicePaths); null for any other
// path. With `literal`, `.` and `..` are kept as parts, as `\\?\` and `\??\` pass them on.
function devicePathReadings(value, { literal = false } = {}) {
  if (typeof value !== "string") return null;
  const start = DEVICE_PATH_START.exec(value);
  if (!start) return null;
  let text = value.slice(start[0].length);
  if (/['"]$/.test(text)) text = text.slice(0, -1);
  const parts = text.split(/[\\/]/);
  const readings = windowsReadings(parts, { literal }).map(belowDeviceRoot);
  // The root as the system looks it up: `\\?\` and `\??\` open it as written, so `\\?\C:.\` (or
  // `HarddiskVolume3.`, `Global.`, `UNC.`) is a name a program could define pointing anywhere, not the drive;
  // `\\.\` tidies it, dropping only a part's one last dot, so `\\.\C:.\` is the drive but `\\.\C: \`,
  // `\\.\C:. \` and `\\.\C:..\` are names too. A stream name on it (`HarddiskVolume3:x`, `UNC:x`) is part of
  // the name, either way. Where that root is no name Guard knows, only that reading is given, so the path is
  // judged as one through a name Guard can't place (see opensUnknownDevice), and no other name is looked up
  // in its place.
  const exact = EXACT_DEVICE_PATH_START.test(value);
  const rootReadings = windowsReadings(parts, { literal, streams: true });
  const opened = belowDeviceRoot(rootReadings[exact ? 0 : 1]);
  if (!knownDeviceRoot(opened)) return [opened];
  return readings;
}

// A device path's parts without the device root's other names (see localDevicePaths).
function belowDeviceRoot(resolved) {
  // Counted, not cut off one at a time, so a path padded with thousands of them still takes one pass.
  let root = 0;
  for (;;) {
    const names = otherRootNames(resolved, root);
    if (!names) break;
    root += names;
  }
  return root ? resolved.slice(root) : resolved;
}

// How many parts from `root` on are another name for the device root, or 0.
function otherRootNames(resolved, root) {
  const first = resolved[root] || "";
  if (/^global$/i.test(first)) return 1;
  const second = resolved[root + 1] || "";
  if (/^globalroot$/i.test(first) && /^(?:\?\?|global\?\?|dosdevices)$/i.test(second)) return 2;
  // A logon session's own DOS devices (`GLOBALROOT\Sessions\0\DosDevices\00000000-0001f3a9`), which hold its
  // mapped drives and a `Global` link to the rest, are the same names.
  const sessionDevices = resolved.slice(root, root + 5).join("\\");
  if (/^globalroot\\sessions\\\d+\\dosdevices\\[0-9a-f]+-[0-9a-f]+$/i.test(sessionDevices)) return 5;
  return 0;
}

// The drive paths a path on a drive opens once Windows tidies it, when that isn't the path itself: a part
// ending in a dot, a space or a stream name (`kubelink.\config`, `ENV~1.`) opens as it does behind `\\.\`
// (see localDevicePaths), but Node's own lookups ask for the name as written. Null for any other path, which
// costs no lookup more.
function windowsTidiedPaths(value, cwd) {
  // Only Windows resolves a path to a drive.
  if (process.platform !== "win32" || typeof value !== "string" || typeof cwd !== "string") return null;
  const text = value.replace(/^['"]|['"]$/g, "");
  // A relative path in a share's folder (`\\host\share\proj`) resolves to the share, not a drive.
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(cwd) && !/^(?:[A-Za-z]:|[\\/])/.test(text)) return null;
  const absolutePath = path.resolve(cwd, text);
  if (!/^[A-Za-z]:[\\/]/.test(absolutePath)) return null;
  if (!/[. ](?:[\\/]|$)|:/.test(absolutePath.slice(2))) return null;
  if (remoteLocation(value, cwd)) return null;
  // Only the last part tidied (`notes.`, `ENV~1 `), as most are: its last dots and spaces dropped, as below.
  const last = absolutePath.lastIndexOf("\\");
  const name = trimEndOf(absolutePath.slice(last + 1), ". ");
  const folders = absolutePath.slice(2, last + 1);
  if (name && !/['"]/.test(name) && !/[. ][\\/]|:/.test(folders)) {
    const drivePath = absolutePath.slice(0, last + 1) + name;
    return drivePath === absolutePath ? null : [drivePath];
  }
  const devicePaths = localDevicePaths(`\\\\.\\${absolutePath}`) || [];
  const tidied = devicePaths.filter((drivePath) => drivePath !== absolutePath);
  return tidied.length ? tidied : null;
}

// Whether a `\\?\` or `\??\` path's `.` and `..`, which those can pass on as names, could take it to another
// root (another computer's share, from `\\?\UNC\host\share\..\..\..\C:\...`) than the one Guard reads with
// them resolved. Not when each reading with them kept (see devicePathReadings) starts at the resolved one's
// root, and its path below that root, `..` stopping at the root, is the resolved one's: then the path opens
// that file or nothing, however a program treats the dots.
function dotsMayLeaveRoot(value) {
  if (typeof value !== "string") return false;
  const text = value.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
  if (!/^(?:[\\/]{2,}\?|[\\/]+\?\?)[\\/]/.test(text)) return false;
  if (!/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(text.replace(DEVICE_PATH_START, ""))) return false;
  const literal = devicePathReadings(text, { literal: true }) || [];
  const resolved = devicePathReadings(text) || [];
  if (!literal.length || literal.length !== resolved.length) return true;
  return !literal.every((parts, index) => staysBelowRoot(parts, resolved[index]));
}

// Whether a reading with its dots kept opens below the resolved reading's root, at the resolved reading's
// path.
function staysBelowRoot(parts, opened) {
  const rootLength = deviceRootLength(opened);
  if (!rootLength || deviceRootLength(parts) !== rootLength) return false;
  const root = parts.slice(0, rootLength);
  if (root.some((part) => part === "." || part === "..")) return false;
  if (!samePartsIgnoringCase(root, opened.slice(0, rootLength))) return false;
  const below = [];
  for (const part of parts.slice(rootLength)) {
    if (part === "..") below.pop();
    else if (part !== ".") below.push(part);
  }
  return samePartsIgnoringCase(below, opened.slice(rootLength));
}

function samePartsIgnoringCase(left, right) {
  return left.join("\\").toLowerCase() === right.join("\\").toLowerCase();
}

// How many of a device path reading's first parts name the root below which it opens a path: a drive (`C:`),
// a local volume (see localVolumeStart), or a share's host and share (see shareParts); 0 for any other root.
function deviceRootLength(parts) {
  if (/^[A-Za-z]:[. ]*$/.test(parts[0] || "")) return 1;
  const volume = localVolumeStart(parts);
  if (volume > 0) return volume;
  const share = shareParts(parts);
  if (!share || share.length < 2) return 0;
  return parts.length - share.length + 2;
}

// Whether a path written as one Guard never looks up (see isRemotePath) has a part that could be a Windows
// short name (`ENV~1`, `CREDEN~1.JSO`, also with a stream or last dots or spaces): only a lookup on the disk
// tells which file one opens, so there it could be any secret file. That holds in a WSL folder too, which can
// link to a Windows drive. A relative path in such a folder isn't counted, so `HEAD~1` in a WSL folder still
// passes.
function hasShortNamePart(value) {
  if (!isRemotePath(value)) return false;
  const text = /['"]$/.test(value) ? value.slice(0, -1) : value;
  return text.split(/[\\/]/).some(isShortNamePart);
}

function isShortNamePart(part) {
  const name = trimEndOf(withoutStream(part), ". ");
  return /^[^\s.~]{1,7}~\d{1,6}(?:\.[^\s.]{1,3})?$/.test(name);
}

// ---------- Device roots Guard can place ----------

// The other roots opensUnknownDevice knows, at the top or under `GLOBALROOT\Device`, by what may follow them:
// a share's root names the computer below it, a device that's no file has nothing below it (a folder below
// `COM97` means a program defined that name), and a pipe or mailslot is named below its root.
const SHARE_ROOT_NAME = /^unc$/i;
const SHARE_DEVICE_NAME = /^(?:mup|lanmanredirector|webdavredirector|rdpdr|p9rdr)$/i;
const NO_FILE_NAME = /^(?:nul|con|conin\$|conout\$|prn|aux|com\d+|lpt\d+|physicaldrive\d+|tape\d+|display\d+)$/i;
const NO_FILE_DEVICE_NAME = /^null$/i;
const PIPE_NAME = /^(?:pipe|mailslot)$/i;
const PIPE_DEVICE_NAME = /^(?:namedpipe|mailslot)$/i;
const TOP_ROOT_NAMES = { share: SHARE_ROOT_NAME, noFile: NO_FILE_NAME, pipe: PIPE_NAME };
const DEVICE_ROOT_NAMES = { share: SHARE_DEVICE_NAME, noFile: NO_FILE_DEVICE_NAME, pipe: PIPE_DEVICE_NAME };

// Whether a Windows device path goes through a name Guard can't place without a lookup it mustn't make:
// anything but a drive (`\\?\C:\`), another computer's share (`UNC`, `GLOBALROOT\Device\Mup` and the other
// redirectors), a local volume by one of the system's own names for it (see localVolumeStart), or a device
// that's no file (`pipe`, `NUL`). A volume's interface name (`STORAGE#Volume#...`), a link a program made
// among the session's objects, a DOS device a program defined or another driver's device can each open any
// folder on this computer, so a path through one could be any secret file; and some reach another computer,
// so none is looked up.
function opensUnknownDevice(value) {
  // devicePathReadings gives only the reading the system opens when its root is no name Guard knows, and the
  // tidied reading, whose root is the one the system opens, last.
  const readings = devicePathReadings(value);
  return Boolean(readings) && !knownDeviceRoot(readings[readings.length - 1]);
}

// The root is judged as the system opens it (see devicePathReadings): `C:.`, `C: ` and `HarddiskVolume3:x`
// are no names Guard knows.
function knownDeviceRoot([first = "", ...below]) {
  if (/^[A-Za-z]:$/.test(first) || localVolumeStart([first, ...below]) > 0) return true;
  const device = /^globalroot$/i.test(first) && /^device$/i.test(below[0] || "");
  if (device) return knownRootName(below[1] || "", below.slice(2), DEVICE_ROOT_NAMES);
  return knownRootName(first, below, TOP_ROOT_NAMES);
}

// Whether a root name is one Guard knows, given what follows it (see the names above).
function knownRootName(name, rest, names) {
  if (names.share.test(name)) return rest.length > 0;
  if (names.noFile.test(name)) return rest.length === 0;
  return names.pipe.test(name);
}

// ---------- Shares on a computer ----------

// A drive's own share on a computer, `\\localhost\C$\proj\.env`, `//host/c$/...`, `\\?\UNC\host\C$\...`,
// `\\.\UNC\host\C$\...` or `\\.\GLOBALROOT\Device\Mup\host\C$\...`, or a relative path in a folder on one:
// each drive path it names on that computer (`C:\proj\.env`), with whether the computer is this one (see
// isLoopbackHost). Null for any other path. Any computer's share is mapped, so a name hidden by the share's
// form is still seen; only this computer's is looked up, and only on its own drive: the share itself never is
// (see isRemotePath). A local volume's device path by any of the system's names for it
// (`\\?\Volume{...}\proj\.env`, `\\.\HarddiskVolume3\...`, see localVolumeStart) gives the drive path the
// system resolves it to, with `lookups` (see volumeDrivePath), as this computer's.
function driveSharePaths(value, cwd, { lookups = true, budget } = {}) {
  if (typeof value !== "string") return null;
  const text = shareText(value, cwd);
  if (text === null) return null;
  // Where `.` and `..` could take the path to another root (see dotsMayLeaveRoot), this computer's drive path
  // is still looked up for a link or a short name, as the system or a program may resolve them, but one that
  // passes them on could open another computer's file there, so the item is `dotted`: a read isn't checked
  // from the drive.
  const literalDots = dotsMayLeaveRoot(text);
  const found = [];
  const device = devicePathReadings(text);
  let readings;
  if (device) readings = deviceShareReadings(device, { lookups, budget, literalDots, found });
  else if (/^[\\/]{2,}[^\\/?]/.test(text)) readings = plainShareReadings(text);
  else return null;
  for (const [host = "", share = "", ...rest] of readings) {
    const letter = /^([A-Za-z])\$$/.exec(trimEndOf(withoutStream(share), ". "));
    if (!host || !letter) continue;
    const drive = `${letter[1]}:\\${rest.join("\\")}`;
    const loopback = isLoopbackHost(host);
    const dotted = literalDots && loopback;
    if (!found.some((item) => item.drive === drive && item.loopback === loopback)) {
      found.push({ drive, loopback, ...(dotted ? { dotted } : {}) });
    }
  }
  return found.length ? found : null;
}

// The path driveSharePaths reads, unquoted and joined to a share folder it's named from, or null where it can
// be no share.
function shareText(value, cwd) {
  let text = value.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
  // A path on a drive is no share, whatever folder it's named from.
  if (/^[A-Za-z]:[\\/]/.test(text)) return null;
  if (!NETWORK_PATH.test(text) && typeof cwd === "string" && NETWORK_PATH.test(cwd)) {
    // A device path folder (`\??\UNC\host\C$\proj`) is joined as it is: Node would read it as a folder on
    // this drive.
    const folder = cwd.replace(/^\s*['"]?/, "").replace(/['"]$/, "");
    if (!DEVICE_PATH_START.test(folder)) text = path.win32.resolve(folder, text);
    else if (!path.win32.isAbsolute(text)) text = `${folder}\\${text}`;
  }
  // Both forms start with a slash: anything else is no share, without the tests below.
  if (!/^[\\/]/.test(text)) return null;
  return text;
}

// A device path's share readings, `host\share\rest`. A local volume by one of the system's names for it (see
// localVolumeStart) gives no reading: its drive path goes straight on `found`. Else `UNC\host\share`, or the
// same root by a device name (see shareParts).
function deviceShareReadings(device, { lookups, budget, literalDots, found }) {
  const lookedUp = new Set();
  return device.flatMap((parts) => {
    const volumeStart = localVolumeStart(parts);
    if (volumeStart > 0) {
      // The same path read two ways is looked up once. A volume with no drive letter gives the path it
      // resolves to, judged by its name, as the volume isn't looked up again.
      const key = parts.join("\\");
      if (lookups && !lookedUp.has(key)) {
        lookedUp.add(key);
        const drive = volumeDrivePath(parts, volumeStart, budget);
        const loopback = Boolean(drive) && /^[A-Za-z]:\\/.test(drive);
        if (drive) found.push({ drive, loopback, ...(literalDots && loopback ? { dotted: true } : {}) });
      }
      return [];
    }
    const share = shareParts(parts);
    return share ? [share] : [];
  });
}

// A `\\host\share\rest` path's readings, `host\share\rest`. `..` stops at the share, as Windows reads a share
// path; it's also read going past the share, to be safe. A path written into a script's string doubles its
// backslashes (`\\\\localhost\\C$\\...`), so separators are read as one.
function plainShareReadings(text) {
  const [host, share, ...rest] = text.replace(/^[\\/]+/, "").split(/[\\/]+/);
  const readings = windowsReadings([share, ...rest]);
  if (rest.includes("..")) readings.push(...windowsReadings(rest).map((parts) => [share, ...parts]));
  return readings.map((parts) => [host, ...parts]);
}

// A device path's `host\share\rest` parts below `UNC`, or the same root by a device name,
// `GLOBALROOT\Device\Mup` or `...\LanmanRedirector`, with any `;provider` parts after it; null for any other
// root.
function shareParts(parts) {
  let start = -1;
  if (/^unc$/i.test(parts[0] || "")) start = 1;
  else if (/^globalroot\\device\\(?:mup|lanmanredirector)$/i.test(parts.slice(0, 3).join("\\"))) start = 3;
  if (start < 0) return null;
  while ((parts[start] || "").startsWith(";")) start += 1;
  return parts.slice(start);
}

// ---------- Local volumes ----------

// The system's names for a local disk volume: at the top of its namespace, and under `GLOBALROOT\Device`.
const VOLUME_NAME = new RegExp(
  `^(?:${[
    "volume\\{[0-9a-f-]+\\}",
    "harddiskvolume(?:shadowcopy)?\\d+",
    "harddisk\\d+partition\\d+",
    "bootpartition",
    "systempartition",
    "cdrom\\d+",
  ].join("|")})$`,
  "i",
);
const VOLUME_DEVICE_NAME = new RegExp(
  `^(?:${[
    "volume\\{[0-9a-f-]+\\}",
    "harddiskvolume(?:shadowcopy)?\\d+",
    "bootdevice",
    "bootpartition",
    "systempartition",
    "cdrom\\d+",
  ].join("|")})$`,
  "i",
);

// Where the path below a local volume's device name starts in a device path's `parts`, or -1 for any other
// name. Only the system's own names for a disk volume are listed (`Volume{...}`, `HarddiskVolume3`,
// `Harddisk0Partition3`, `GLOBALROOT\Device\Harddisk0\Partition3`, `...\BootDevice`,
// `GLOBALROOT\ArcName\...`, `GLOBALROOT\SystemRoot`, ...): any other device name could be a redirector that
// reaches another computer, so it's never looked up.
function localVolumeStart(parts) {
  const [first = "", second = "", third = "", fourth = ""] = parts;
  if (VOLUME_NAME.test(first)) return 1;
  if (!/^globalroot$/i.test(first)) return -1;
  if (/^systemroot$/i.test(second)) return 2;
  // A whole ARC name, `multi(0)disk(0)rdisk(0)partition(3)`: one cut short is no volume's.
  if (/^arcname$/i.test(second) && /^(?:[a-z]+\([0-9a-f]*\))+$/i.test(third)) return 3;
  if (!/^device$/i.test(second)) return -1;
  if (VOLUME_DEVICE_NAME.test(third)) return 3;
  if (/^harddisk\d+$/i.test(third) && /^partition\d+$/i.test(fourth)) return 4;
  return -1;
}

// The drive path the system gives for a local volume's device path (`Volume{...}\rest`,
// `GLOBALROOT\Device\HarddiskVolume3\rest` or another name in localVolumeStart, its parts up to `rest` at
// `start`), with links and short names resolved, or the device path it resolves to on a volume with no drive
// letter; null when nothing is there. One lookup on this computer, counted in `budget`: a check past its
// lookups stops rather than guess.
function volumeDrivePath(parts, start, budget) {
  if (budget) {
    checkShellDeadline(budget);
    if (lookupsSpent(budget)) throw new ShellCheckTooLong();
    budget.lookups -= 1;
  }
  const volume = parts.slice(0, start).join("\\");
  const below = parts.slice(start).join("\\");
  try {
    const resolved = fs.realpathSync.native(`\\\\?\\${volume}\\${below}`);
    return resolved || null;
  } catch {
    return null;
  }
}

// ---------- This computer's names and addresses ----------

// This computer's names and addresses, worked out on first use: no lookup leaves the computer.
let ownHosts = null;
// isLoopbackHost's answers so far: a long command names the same few hosts many times.
const loopbackHosts = new Map();

// Whether a share path's host is this computer: `localhost` (and any name under it), any 127.x address
// however it's written (`127.1`, `0x7f.1`), `::1` (also `[::1]` and `0--1.ipv6-literal.net`), an unspecified
// address, this computer's own name (alone, or with its sign-in domain), or one of its own addresses. Only a
// whole name counts: `<this computer>.example.com` could be another computer's.
function isLoopbackHost(host) {
  if (loopbackHosts.has(host)) return loopbackHosts.get(host);
  const loopback = hostIsThisComputer(host);
  if (loopbackHosts.size < 1024) loopbackHosts.set(host, loopback);
  return loopback;
}

// A host written in fullwidth letters or digits is folded to plain ones first, as Windows reads the name.
function hostIsThisComputer(host) {
  const name = trimEndOf(host.normalize("NFKC").toLowerCase(), ".");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const address = hostAddress(name);
  if (isLoopbackAddress(address)) return true;
  if (!ownHosts) {
    ownHosts = new Set();
    addOwnHosts(ownHosts);
  }
  return ownHosts.has(name) || (address !== null && ownHosts.has(address));
}

// 0.0.0.0, any 127.x, and IPv6's unspecified address and `::1`, in hostAddress's form.
function isLoopbackAddress(address) {
  if (!address) return false;
  if (address === "4:0" || address.startsWith("4:127.")) return true;
  return /^6:(?:0:){7}[01]$/.test(address);
}

function addOwnHosts(hosts) {
  const domain = (process.env.USERDNSDOMAIN || "").toLowerCase();
  for (const own of [os.hostname(), process.env.COMPUTERNAME]) {
    if (typeof own !== "string" || !own) continue;
    hosts.add(own.toLowerCase());
    if (domain && !own.includes(".")) hosts.add(`${own.toLowerCase()}.${domain}`);
  }
  try {
    for (const items of Object.values(os.networkInterfaces())) {
      for (const item of items || []) hosts.add(hostAddress(item.address.toLowerCase()) || item.address);
    }
  } catch {
    // No address list: the names above still count.
  }
}

// An IP address in one written form, `4:<a.b.c.d>` or `6:<eight groups>`, with an IPv4 address inside an IPv6
// one (`::ffff:127.0.0.1`) given as IPv4; null for a name. IPv4 takes every form Windows reads: one to four
// parts, each decimal, octal (`0177`) or hexadecimal (`0x7f`).
function hostAddress(name) {
  if (name.length > 64) return null;
  const ipv4 = ipv4Value(name);
  if (ipv4 !== null) return `4:${ipv4 === 0 ? 0 : dottedQuad(ipv4)}`;
  let text = name.replace(/^\[|\]$/g, "");
  if (text.endsWith(".ipv6-literal.net")) text = text.slice(0, -17).replace(/-/g, ":").replace(/s/g, "%");
  text = text.replace(/%.*$/, "");
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const sides = halves.map((half) => (half ? half.split(":") : []));
  const last = sides[sides.length - 1];
  if (last.length && last[last.length - 1].includes(".")) {
    const inner = ipv4Value(last.pop());
    if (inner === null) return null;
    last.push((inner >>> 16).toString(16), (inner & 0xffff).toString(16));
  }
  const missing = 8 - sides.reduce((sum, side) => sum + side.length, 0);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const filler = Array(halves.length === 2 ? missing : 0).fill("0");
  const groups = [...sides[0], ...filler, ...(sides[1] || [])];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const numbers = groups.map((group) => parseInt(group, 16));
  const ipv4Inside = ipv4InIpv6(numbers);
  if (ipv4Inside !== null) return hostAddress(dottedQuad(ipv4Inside));
  return `6:${numbers.join(":")}`;
}

// The IPv4 address inside a mapped (`::ffff:a.b.c.d`) or compatible (`::a.b.c.d`) IPv6 address, or null. The
// compatible form's 0 and 1 are IPv6's own unspecified address and `::1`.
function ipv4InIpv6(numbers) {
  if (!numbers.slice(0, 5).every((group) => group === 0)) return null;
  if (numbers[5] !== 0xffff && numbers[5] !== 0) return null;
  const inner = numbers[6] * 65536 + numbers[7];
  if (numbers[5] === 0xffff || inner > 1) return inner;
  return null;
}

function dottedQuad(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function ipv4Value(text) {
  const parts = text.split(".");
  if (parts.length > 4) return null;
  if (!parts.every((part) => /^(?:0x[0-9a-f]*|0[0-7]*|[1-9]\d*)$/.test(part))) return null;
  const values = parts.map(ipv4PartValue);
  const last = values.pop();
  if (values.some((value) => value > 255) || last >= 2 ** (8 * (4 - values.length))) return null;
  return values.reduce((sum, value, index) => sum + value * 2 ** (8 * (3 - index)), 0) + last;
}

// One part, hexadecimal (`0x7f`), octal (`0177`) or decimal.
function ipv4PartValue(part) {
  if (/^0x/.test(part)) return parseInt(part.slice(2) || "0", 16);
  if (/^0/.test(part)) return parseInt(part, 8);
  return Number(part);
}

// ---------- Drive-relative paths ----------

// A Windows drive-relative path (`D:.env`, `D:config\.env`, `C:` alone): its drive letter, upper case, and
// what follows the colon. Null for any other path. A shell word with a part holding more colons than a path's
// stream and type (`s:a:b:`, where `kubelink:$I30:$INDEX_ALLOCATION` is a folder's), or one part with a space
// after the colon (`a: b`), names no path.
function driveRelativeParts(value) {
  // Every operand of a long command is asked, so a word that can't start with a drive letter and a colon,
  // once a quote and the spaces before it are taken off, is turned away before anything else is built.
  if (typeof value !== "string" || !/^(?:\s*['"])?[A-Za-z]:/.test(value)) return null;
  const unquoted = value.replace(/^\s*['"]/, "").replace(/['"]\s*$/, "");
  const match = /^([A-Za-z]):([\s\S]*)$/.exec(unquoted);
  if (!match || /^[\\/]/.test(match[2])) return null;
  const rest = match[2];
  if (/^\s/.test(rest) && !/[\\/]/.test(rest)) return null;
  const pathPart = /^[^:]*(?::[^:]*)?(?::\$[A-Za-z_]+)?$/;
  if (!rest.split(/[\\/]+/).every((part) => pathPart.test(part))) return null;
  return { drive: match[1].toUpperCase(), rest };
}

// Where Windows opens a drive-relative path: below its drive's current folder. That folder is known when the
// working folder is on the same drive, or from the `=D:` variable cmd keeps for each drive. Null when neither
// tells, and for any other path.
function driveRelativePlace(value, cwd, env = process.env) {
  const parts = driveRelativeParts(value);
  if (!parts) return null;
  const folder = typeof cwd === "string" ? cwd.replace(/^\s*['"]/, "").replace(/['"]\s*$/, "") : null;
  const kept = env?.[`=${parts.drive}:`] ?? env?.[`=${parts.drive.toLowerCase()}:`];
  let base = null;
  if (isFolderOnDrive(folder, parts.drive)) base = folder;
  else if (isFolderOnDrive(kept, parts.drive)) base = kept;
  return base ? path.win32.resolve(base, parts.rest) : null;
}

function isFolderOnDrive(folder, drive) {
  if (typeof folder !== "string" || folder.length <= 2) return false;
  return folder[0].toUpperCase() === drive && /^.:[\\/]/.test(folder);
}

// Whether a Windows drive-relative path (`C:Users\me\.kube\config`) is named from a folder on another
// computer: it opens below that drive's own working folder, which Guard can't see from there, so it could be
// any file on the drive, and it's judged as one through a name Guard can't place (see opensUnknownDevice).
// `C:` alone is that folder.
function driveRelativeFromRemote(value, cwd = process.cwd()) {
  if (process.platform !== "win32" || typeof cwd !== "string") return false;
  return driveRelativeParts(value) !== null && isRemotePath(cwd);
}

module.exports = {
  NETWORK_PATH,
  AUTOMOUNT_PATH,
  VOLUME_PATH,
  underRoot,
  isRemotePath,
  trimEndOf,
  withoutStream,
  DEVICE_PATH_START,
  localDevicePaths,
  devicePathReadings,
  EXACT_DEVICE_PATH_START,
  belowDeviceRoot,
  windowsReadings,
  windowsTidiedPaths,
  driveSharePaths,
  shareParts,
  deviceRootLength,
  dotsMayLeaveRoot,
  VOLUME_NAME,
  VOLUME_DEVICE_NAME,
  localVolumeStart,
  volumeDrivePath,
  ownHosts,
  isLoopbackHost,
  loopbackHosts,
  hostIsThisComputer,
  hostAddress,
  ipv4Value,
  hasShortNamePart,
  opensUnknownDevice,
  SHARE_ROOT_NAME,
  SHARE_DEVICE_NAME,
  NO_FILE_NAME,
  NO_FILE_DEVICE_NAME,
  PIPE_NAME,
  PIPE_DEVICE_NAME,
  knownDeviceRoot,
  locationIs,
  remoteLocation,
  driveRelativeParts,
  driveRelativePlace,
  driveRelativeFromRemote,
  onMountedVolume,
  isDirectoryTarget,
};
