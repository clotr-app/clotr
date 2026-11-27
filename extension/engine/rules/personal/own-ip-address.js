// findMyIps(): a public IP address the person says is their own.
(() => {
  "use strict";

  // ── Your own IP ───────────────────────────────────
  // Reads your public IP when you say it's yours, as in "my home IP is 73.162.44.201". Private ranges are
  // handled by internal_ip instead.

  const MY_IP_LABEL = String.raw`\b(?:my|our)\s+(?:home\s+|public\s+|router\s+|wan\s+|external\s+)?ip(?:\s+address)?`;
  const MY_IP_RE = new RegExp(String.raw`${MY_IP_LABEL}\s*(?:is|:|=)\s*((?:\d{1,3}\.){3}\d{1,3})\b`, "gi");
  const PRIVATE_IP = /^(?:10|127|0)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^169\.254\./;

  function publicIp(ip) {
    return ip.split(".").every((part) => Number(part) <= 255) && !PRIVATE_IP.test(ip);
  }

  function findMyIps(text) {
    return [...text.matchAll(MY_IP_RE)].map((match) => match[1]).filter(publicIp);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findMyIps };
})();
