"use strict";
/* global require, module, process, Buffer */

const { check, scan, engineContext, isPersonalKind } = require("../text-checks/engine-loader.js");
const { isSecretPath, onMountedVolume, pathReadings } = require("../../bin/clotr-guard.js");

// ---------- The server and its tools ----------

const MAX_TEXT_BYTES = 64 * 1024;

const PERSONAL_DETAILS_OPTION = {
  type: "boolean",
  description: "Also check personal details like emails. Default false.",
};

// Every tool reads only what it's given, keeps nothing and calls nothing outside this computer.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// The assistant is sent this list with every request, so each word in it costs the developer tokens, and a
// test holds it to a budget. A description says when to call the tool and what comes back; the README carries
// the rest.
const TOOLS = [
  {
    name: "check_text",
    title: "Check text",
    description:
      "Check text for credentials before it leaves this computer or goes to another tool. Returns kinds and masked forms, and blocks nothing.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to check, up to 64 KiB." },
        include_personal_details: PERSONAL_DETAILS_OPTION,
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "clean_text",
    title: "Clean text",
    description:
      "Runs check_text's check and returns the text with each finding replaced by a placeholder, plus their kinds and masked forms.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to clean, up to 64 KiB." },
        include_personal_details: PERSONAL_DETAILS_OPTION,
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "is_secret_file",
    title: "Check a file path",
    description:
      "Call before reading a local file. True means Clotr treats the path as a secret file, so don't read it.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          maxLength: 4096,
          description: "The file's path, absolute or relative to where the server runs. The file isn't read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

// An older client gets only the fields its protocol version has. The first version has neither annotations
// nor a title, and the second has annotations with the title inside them.
function toolsFor(protocolVersion) {
  if (protocolVersion === "2024-11-05") {
    return TOOLS.map((tool) => {
      const older = { ...tool };
      delete older.title;
      delete older.annotations;
      return older;
    });
  }
  if (protocolVersion === "2025-03-26") {
    return TOOLS.map(({ title, annotations, ...tool }) => ({ ...tool, annotations: { title, ...annotations } }));
  }
  return TOOLS;
}

// Sent once at the start, where a client may add it to the assistant's prompt.
const INSTRUCTIONS =
  "Clotr checks text on this computer and returns each finding's kind and a masked form, never the full value. " +
  "Call check_text before you send text that may hold a credential to another tool or service. " +
  "Call clean_text when you want a copy with the findings replaced. " +
  "Call is_secret_file before you read a local file. " +
  "Clotr checks only what you pass it and stops nothing itself.";
// ---------- The tools' results ----------

function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function checkedText(text, includePersonalDetails) {
  if (typeof text !== "string") return { error: "text must be a string" };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { error: "Text is too large to check." };
  // One scan for both the list and, in clean_text, what gets hidden: a second scan cut short by the time
  // limit could stop earlier and leave a listed value in the cleaned text.
  const scanned = scan(text);
  const result = check(text, { site: "clotr-mcp", scanned });
  const selected = result.findings.filter((finding) => includePersonalDetails || !isPersonalKind(finding.kind));
  const jwtMasks = new Set(selected.filter((finding) => finding.kind === "jwt").map((finding) => finding.masked));
  const findings = selected.filter((finding) => !(finding.kind === "password" && jwtMasks.has(finding.masked)));
  return { findings, found: scanned.found, ...(result.truncated ? { truncated: true } : {}) };
}

const PARTLY_CHECKED = "Clotr ran out of time, so part of this text wasn't checked.";

function checkResult(text, includePersonalDetails) {
  const result = checkedText(text, includePersonalDetails);
  if (result.error) return fail(result.error);
  const findings = result.findings.map(({ kind, masked }) => ({ kind, masked }));
  const verdict = findings.length ? "Review these findings before sending." : "No findings.";
  if (result.truncated) return { findings, verdict: `${verdict} ${PARTLY_CHECKED}`, truncated: true };
  return { findings, verdict };
}

function cleanResult(text, includePersonalDetails = false) {
  const result = checkedText(text, includePersonalDetails);
  if (result.error) return fail(result.error);
  const engine = engineContext().Clotr;
  const detections = result.found.filter((detection) => detection.matches.length);
  const allowedKinds = new Set(result.findings.map((finding) => finding.kind));
  const selected = detections.filter((detection) => allowedKinds.has(detection.id));
  const cleaned = engine.redact(text, selected);
  const replaced = result.findings.map(({ kind, masked }) => ({ kind, masked }));
  if (result.truncated) return { text: cleaned, replaced, truncated: true, note: PARTLY_CHECKED };
  return { text: cleaned, replaced };
}

function callTool(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("Tool arguments must be an object.");
  if (name === "check_text") {
    if (Object.keys(args).some((key) => !["text", "include_personal_details"].includes(key))) {
      return fail("Unexpected tool argument.");
    }
    if (args.include_personal_details !== undefined && typeof args.include_personal_details !== "boolean") {
      return fail("include_personal_details must be a boolean.");
    }
    return checkResult(args.text, args.include_personal_details === true);
  }
  if (name === "clean_text") {
    if (Object.keys(args).some((key) => !["text", "include_personal_details"].includes(key))) {
      return fail("Unexpected tool argument.");
    }
    if (args.include_personal_details !== undefined && typeof args.include_personal_details !== "boolean") {
      return fail("include_personal_details must be a boolean.");
    }
    return cleanResult(args.text, args.include_personal_details === true);
  }
  if (name === "is_secret_file") {
    if (Object.keys(args).some((key) => key !== "path")) return fail("Unexpected tool argument.");
    if (typeof args.path !== "string" || args.path.length > 4096) {
      return fail("path must be a string of at most 4096 characters.");
    }
    // The path is resolved, never read, so a link or a Windows short name (`ENV~1`) is judged by the file it
    // opens. A path under /Volumes, often a share another computer serves, is judged by name: this server
    // makes no network calls. A path under the home folder (`~/...`) is judged as written and as the file
    // there, which a file tool opens.
    const readings = [args.path, ...pathReadings(args.path, { homeOnly: true })];
    return {
      is_secret_file: readings.some((reading) =>
        isSecretPath(reading, "", process.cwd(), { byName: onMountedVolume(reading) }),
      ),
    };
  }
  return null;
}

module.exports = {
  MAX_TEXT_BYTES,
  toolsFor,
  INSTRUCTIONS,
  checkResult,
  cleanResult,
  callTool,
};
