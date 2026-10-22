"use strict";

globalThis.Clotr ||= {};

const OneClotrBridge = {
  HOST: "app.clotr.bridge",
  async request(message) {
    if (!chrome.runtime.sendNativeMessage) throw new Error("native messaging unavailable");
    const reply = await Promise.race([
      chrome.runtime.sendNativeMessage(this.HOST, message),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    if (!reply || reply.type === "unknown" || reply.type === "not_running") throw new Error(reply?.type || "no reply");
    if (reply.type === "forgotten") {
      const protocol = globalThis.Clotr.OneClotrProtocol;
      const checkedForgotten = Object.hasOwn(reply, "forgotten")
        ? protocol.inspectForgotten(reply.forgotten)
        : { items: [], problem: null };
      if (checkedForgotten.problem) {
        console.warn(`[Clotr] forgotten ${checkedForgotten.problem} ignored.`);
        throw new Error("unexpected reply");
      }
      if (checkedForgotten.items.length) {
        const stored = await chrome.storage.local.get([...protocol.SETTINGS, "oneClotrMeta"]);
        const { set, remove } = protocol.apply(stored, { forgotten: checkedForgotten.items }, Date.now());
        await chrome.storage.local.set({ ...set, oneClotrPaired: false });
        if (remove.length) await chrome.storage.local.remove(remove);
      } else {
        await chrome.storage.local.set({ oneClotrPaired: false });
      }
      await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
      return reply;
    }
    if (!(await globalThis.Clotr.OneClotrProtocol.valid(reply, "host"))) throw new Error("unexpected reply");
    return reply;
  },
  async connectFromClick(browser) {
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (!granted) return { type: "not_granted" };
    const hello = await this.request({ v: 1, type: "hello", role: "extension", browser });
    if (hello.type !== "hello_ack") return hello;
    if (hello.paired) return { type: "connected" };
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      const reply = await this.request({ v: 1, type: "pair_request" });
      if (reply.type === "pair_done") return { type: "connected" };
      if (reply.type !== "pair_pending") throw new Error("unexpected reply");
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return { type: "waiting" };
  },
  async readSettings() {
    const reply = await this.request({ v: 1, type: "read_settings" });
    if (reply.type !== "settings") throw new Error("unexpected reply");
    return globalThis.Clotr.OneClotrProtocol.cleanSettings(reply.settings);
  },
  async writeSettings(settings) {
    const clean = globalThis.Clotr.OneClotrProtocol.cleanSettings(settings);
    return this.request({ v: 1, type: "write_settings", settings: clean });
  },
  async disconnect() {
    await this.request({ v: 1, type: "forget" });
    await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    return { type: "disconnected" };
  },
};

globalThis.Clotr.OneClotrBridge = OneClotrBridge;
