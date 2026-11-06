// A small stand-in for an extension page: just enough DOM and chrome.* for a page script to load in a vm, so a
// test can click its buttons and read what it shows. Not a browser: elements are made on first use by id, and
// selectors only answer what the test sets up. Storage is in memory and fires onChanged like the real one.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");

class FakeNode {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.hidden = false;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    };
    this.parentElement = null;
    this.found = {};
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === "string" ? Object.assign(new FakeNode("#text"), { textContent: n }) : n;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  // Runs the listeners and waits for what they return (the page's handlers are mostly async).
  async fire(type, event = {}) {
    const ev = { preventDefault() {}, target: this, key: "", ...event };
    for (const fn of this.listeners[type] || []) await fn(ev);
  }
  querySelector(sel) {
    return (this.found[sel] ||= new FakeNode("div"));
  }
  querySelectorAll() {
    return [];
  }
  get tBodies() {
    return [(this.found.tbody ||= new FakeNode("tbody"))];
  }
  scrollIntoView() {}
  focus() {}
  // All the text under this node, the way innerText would join it.
  get text() {
    return [this.textContent, ...this.children.map((c) => c.text)].filter(Boolean).join(" ");
  }
}

function fakeArea(name, onChange) {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      onChange(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of typeof keys === "string" ? [keys] : keys) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      onChange(changes, name);
    },
  };
}

// Loads `scripts` (file names in extension/) into one vm context and returns its pieces.
// options: local / session (what storage holds as the page opens), hidden (ids the HTML starts hidden), manifest (merged over the real one), messages (a locale's messages.json, for chrome.i18n),
// sendMessage (the background's answer), selectors / selectorsAll (document.querySelector[All] answers),
// globals (anything else the page expects).
function loadPage(scripts, options = {}) {
  const els = {};
  // Elements the page's HTML starts hidden.
  for (const id of options.hidden || []) els[id] = Object.assign(new FakeNode("div", id), { hidden: true });
  const changed = [];
  const fireChanged = (changes, area) => {
    for (const fn of changed) fn(changes, area);
  };
  const local = fakeArea("local", fireChanged);
  const session = fakeArea("session", fireChanged);
  Object.assign(local.data, structuredClone(options.local || {}));
  Object.assign(session.data, structuredClone(options.session || {}));
  const manifest = {
    ...JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")),
    ...(options.manifest || {}),
  };
  const permissionListeners = { added: [], removed: [] };
  const granted = { origins: [...(manifest.host_permissions || [])], permissions: [...(manifest.permissions || [])] };
  const messages = options.messages || {};
  const tabs = [];
  const chrome = {
    i18n: {
      getUILanguage: () => "en",
      getMessage(key, subs = []) {
        const m = messages[key];
        if (!m) return "";
        const named = Object.fromEntries(
          Object.entries(m.placeholders || {}).map(([k, v]) => [k.toLowerCase(), v.content]),
        );
        return m.message
          .replace(/\$([A-Za-z0-9_]+)\$/g, (_, n) => named[n.toLowerCase()] ?? "")
          .replace(/\$(\d)/g, (_, n) => subs[n - 1] ?? "");
      },
    },
    runtime: {
      getManifest: () => manifest,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (m) => (options.sendMessage ? options.sendMessage(m) : {}),
    },
    storage: {
      local,
      session,
      managed: { get: async () => options.managed || {} },
      onChanged: { addListener: (fn) => changed.push(fn) },
    },
    permissions: {
      getAll: async () => structuredClone(granted),
      contains: async ({ origins = [] }) => origins.every((o) => granted.origins.includes(o)),
      request: async () => false,
      onAdded: { addListener: (fn) => permissionListeners.added.push(fn) },
      onRemoved: { addListener: (fn) => permissionListeners.removed.push(fn) },
    },
    tabs: { create: async (t) => tabs.push(t), getCurrent: async () => null, remove: async () => {} },
    action: {},
  };
  const document = {
    title: "",
    body: new FakeNode("body"),
    getElementById: (id) => (els[id] ||= new FakeNode("div", id)),
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    querySelector: (sel) => (options.selectors || {})[sel] ?? null,
    querySelectorAll: (sel) => (options.selectorsAll || {})[sel] ?? [],
    addEventListener() {},
  };
  const ctx = {
    console,
    document,
    chrome,
    location: { hash: "", search: "", ...(options.location || {}) },
    window: { addEventListener() {} },
    navigator: { userAgent: "", language: "en" },
    getSelection: () => ({ selectAllChildren() {} }),
    fetch: async () => ({ ok: false, json: async () => [] }),
    URL,
    URLSearchParams,
    Intl,
    TextEncoder,
    crypto: globalThis.crypto,
    structuredClone,
    // A page's timers never keep the test running on their own.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args).unref(),
    clearTimeout,
    setInterval: (fn, ms, ...args) => setInterval(fn, ms, ...args).unref(),
    clearInterval,
    ...(options.globals || {}),
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), ctx, { filename: file });
  }
  return {
    ctx,
    chrome,
    $: document.getElementById,
    local,
    session,
    tabs,
    // Changes the browser's grants and tells the page, as permissions.onAdded / onRemoved would.
    async grant(origins) {
      granted.origins.push(...origins);
      for (const fn of permissionListeners.added) await fn({ origins });
    },
  };
}

// Lets the page's pending promises (storage reads, renders) settle.
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

const locale = (lang) => JSON.parse(fs.readFileSync(path.join(EXT, "_locales", lang, "messages.json"), "utf8"));

module.exports = { FakeNode, loadPage, settle, locale, EXT };
