// A script I run by hand, not part of the extension, to check whether an AI site sends what you've typed
// before you press Send. Inject it before the page loads so it can wrap fetch, XMLHttpRequest, sendBeacon and
// WebSocket ahead of the site's own code.
//
// How to use: load the site with this injected, focus the chat box, and type (don't send) a sentence
// containing "zqxprobe1234" and the fake number 555-555-0147. After about 10 seconds, window.__hits should
// still be empty. Then press Enter once as a control; that real send should show up in window.__hits, which
// proves the script can see the site's traffic. It can't see requests from service workers, other frames, or
// bodies compressed with CompressionStream.
(() => {
  const M = /zqxprobe|555-0147|5550147/i;
  window.__sends = 0;
  window.__hits = [];
  const text = (b) => {
    try {
      if (b == null) return "";
      if (typeof b === "string") return b;
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) {
        let s = "";
        for (const [k, v] of b) s += `${k}=${v}&`;
        return s;
      }
      if (b instanceof Blob) return "[blob]";
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
      return String(b);
    } catch {
      return "";
    }
  };
  const note = (kind, url, body) => {
    window.__sends++;
    let s = text(body);
    try {
      s += decodeURIComponent(s);
    } catch {
      /* not URL-encoded */
    }
    if (M.test(s) || M.test(String(url))) window.__hits.push(`${kind} ${String(url).slice(0, 120)}`);
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    note("fetch", (input && input.url) || input, init && init.body);
    return f.apply(this, arguments);
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = u;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    note("xhr", this.__u, b);
    return send.apply(this, arguments);
  };
  const beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (u, b) {
    note("beacon", u, b);
    return beacon(u, b);
  };
  const ws = WebSocket.prototype.send;
  WebSocket.prototype.send = function (b) {
    note("websocket", this.url, b);
    return ws.apply(this, arguments);
  };
})();
