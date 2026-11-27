"use strict";
/* global require, module, Buffer */

const { MAX_TEXT_BYTES, toolsFor, INSTRUCTIONS, callTool } = require("./mcp-tools.js");

// ---------- The server and its tools ----------

const SERVER_NAME = "clotr";

// MCP's own number, typed in since server.json isn't in the npm package; tests keep it equal to
// server.json's.
const SERVER_VERSION = "0.1.4";
const CURRENT_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

// Of the versions served, only BATCH_PROTOCOL has batches. One batch runs at most this many requests, with at
// most MAX_TEXT_BYTES of text between them, so it asks for about what one call can; each request past that
// gets an error with its id.
const BATCH_PROTOCOL = "2025-03-26";
const MAX_BATCH_CALLS = 16;
// ---------- The tools' results ----------

function toolResponse(result, modern) {
  const encoded = JSON.stringify(result);
  return {
    content: [{ type: "text", text: encoded }],
    isError: Boolean(result.isError),
    ...(modern ? { resultType: "complete" } : {}),
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
// ---------- JSON-RPC ----------

let protocolMode = null;
let legacyProtocol = null;

function rpcResult(request, result, { cacheable = false, modern = false } = {}) {
  if (!modern) return { jsonrpc: "2.0", id: request.id, result };
  const value = {
    ...result,
    resultType: "complete",
    _meta: { [SERVER_INFO_META]: { name: SERVER_NAME, version: SERVER_VERSION } },
    ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
  };
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: value,
  };
}

function handleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0") {
    return rpcError(request?.id, -32600, "Invalid Request");
  }
  // JSON-RPC never answers a notification, not even with an error, so none of the checks below may reply to
  // one.
  if (!Object.hasOwn(request, "id")) return null;
  const method = request.method;
  const params =
    request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params : {};
  const requestMeta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const requestedProtocol = requestMeta[PROTOCOL_META];
  const modern = method === "server/discover" || protocolMode === "modern" || requestedProtocol === CURRENT_PROTOCOL;

  const problem = protocolProblem(request, method, modern, requestedProtocol);
  if (problem) return problem;

  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "initialize") return initializeResult(request, params);
  if (method === "server/discover") {
    protocolMode = "modern";
    return rpcResult(
      request,
      { supportedVersions: [CURRENT_PROTOCOL], capabilities: { tools: {} }, instructions: INSTRUCTIONS },
      { cacheable: true, modern: true },
    );
  }
  if (method === "ping") return rpcResult(request, {}, { modern });
  if (method === "tools/list") {
    const tools = toolsFor(modern ? CURRENT_PROTOCOL : legacyProtocol);
    return rpcResult(request, { tools }, { cacheable: true, modern });
  }
  if (method === "tools/call") {
    if (typeof params.name !== "string") return rpcError(request.id, -32602, "Tool name is required");
    const result = callTool(params.name, params.arguments);
    if (!result) return rpcError(request.id, -32602, "Unknown tool");
    return rpcResult(request, toolResponse(result, modern), { modern });
  }
  return rpcError(request.id, -32601, "Method not found");
}

// The error for a request the protocol in use can't answer: a modern request on another version or none, or
// any request but the two handshakes before one of them; null for none.
function protocolProblem(request, method, modern, requestedProtocol) {
  if (modern && requestedProtocol !== undefined && requestedProtocol !== CURRENT_PROTOCOL) {
    return {
      ...rpcError(request.id, -32022, "Unsupported protocol version"),
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [CURRENT_PROTOCOL] },
      },
    };
  }
  if (modern && requestedProtocol === undefined) {
    return {
      ...rpcError(request.id, -32022, "Protocol version is required"),
      error: {
        code: -32022,
        message: "Protocol version is required",
        data: { supported: [CURRENT_PROTOCOL], requested: "" },
      },
    };
  }
  if (protocolMode === null && method !== "initialize" && method !== "server/discover" && !modern) {
    return rpcError(request.id, -32002, "Server is not initialized");
  }
  return null;
}

// The legacy handshake's answer, which sets the protocol the rest of the session is served on.
function initializeResult(request, params) {
  const requested = params.protocolVersion;
  const protocolVersion = LEGACY_PROTOCOLS.has(requested) ? requested : "2025-11-25";
  protocolMode = "legacy";
  legacyProtocol = protocolVersion;
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    },
  };
}
// ---------- Stdio framing ----------

function answer(request) {
  try {
    return handleRequest(request);
  } catch {
    return request && Object.hasOwn(request, "id") ? rpcError(request.id, -32603, "Internal error") : null;
  }
}

function batchTextBytes(request) {
  const text = request?.method === "tools/call" ? request.params?.arguments?.text : undefined;
  if (typeof text !== "string") return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  // A text over the cap is refused without being checked, so it uses none of the batch's allowance.
  return bytes > MAX_TEXT_BYTES ? 0 : bytes;
}

function isRequestWithId(item) {
  return Boolean(item) && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "id");
}

// The answers to one batch on BATCH_PROTOCOL, as JSON-RPC 2.0 batches them: one array, or nothing when it
// held only notifications. The spec keeps initialize out of a batch.
function batchReplies(batch) {
  const used = { calls: 0, textBytes: 0 };
  const answers = batch.map((item) => {
    if (!isRequestWithId(item) || item.jsonrpc !== "2.0") return answer(item);
    if (item.method === "initialize") return rpcError(item.id, -32600, "Invalid Request");
    used.calls += 1;
    used.textBytes += batchTextBytes(item);
    if (used.calls > MAX_BATCH_CALLS || used.textBytes > MAX_TEXT_BYTES) {
      return rpcError(item.id, -32600, "Batch is too large");
    }
    return answer(item);
  });
  const sent = answers.filter(Boolean);
  return sent.length ? [sent] : [];
}

// What goes back for one message, one line each. Where the version has no batches, or before the handshake
// (which a batch can't hold), each request in a batch gets its own error with its id, and anything else in it
// is left as JSON-RPC leaves it.
function replies(message) {
  if (!Array.isArray(message)) return [answer(message)];
  if (message.length === 0) return [rpcError(null, -32600, "Invalid Request")];
  if (protocolMode === "legacy" && legacyProtocol === BATCH_PROTOCOL) return batchReplies(message);
  return message.map((item) => {
    if (isRequestWithId(item)) return rpcError(item.id, -32600, "Batches aren't supported in this protocol version");
    const isNotification = item && typeof item === "object" && !Array.isArray(item);
    return isNotification ? null : rpcError(null, -32600, "Invalid Request");
  });
}

module.exports = {
  rpcError,
  handleRequest,
  replies,
};
