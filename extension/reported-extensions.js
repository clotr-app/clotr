// Extension check's reported list: extensions a named public source reported for collecting the content of AI
// chats. The list ships with Clotr's own updates and is never fetched. Matching is by id only, since a name can be
// copied by another extension or changed later, so the card always shows the name the browser reports today. This
// is a classic script with no DOM and no chrome.* calls, and I recheck every entry here at each release.
(() => {
  "use strict";

  globalThis.Clotr = globalThis.Clotr || {};
  globalThis.Clotr.reportedExtensions = {
    // The last time every entry below was checked against its source.
    checked: "2026-10-02",
    entries: [
      {
        id: "eppiocemhmnlbhjplcgkofciiegomcon",
        store: "Chrome",
        name: "Urban VPN Proxy",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "nimlmejbmnecnaghgmbahmbaddhjbecg",
        store: "Edge",
        name: "Urban VPN Proxy",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "pphgdbgldlmicfdkhondlafkiomnelnk",
        store: "Chrome",
        name: "1ClickVPN Proxy",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "deopfbighgnpgfmhjeccdifdmhcjckoe",
        store: "Edge",
        name: "1ClickVPN Proxy",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "almalgbpmcfpdaopimbdchdliminoign",
        store: "Chrome",
        name: "Urban Browser Guard",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "jckkfbfmofganecnnpfndfjifnimpcel",
        store: "Edge",
        name: "Urban Browser Guard",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "feflcgofneboehfdeebcfglbodaceghj",
        store: "Chrome",
        name: "Urban Ad Blocker",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "gcogpdjkkamgkakkjgeefgpcheonclca",
        store: "Edge",
        name: "Urban Ad Blocker",
        source: "Koi Security",
        date: "2025-12-15",
        url: "https://thehackernews.com/2025/12/featured-chrome-browser-extension.html",
        what: "collected AI chats",
      },
      {
        id: "fnmihdojmnkclgjpcoonokmkhjpjechg",
        store: "Chrome",
        name: "Chat GPT for Chrome with GPT-5, Claude Sonnet & DeepSeek AI",
        source: "OX Security",
        date: "2025-12-30",
        url: "https://www.ox.security/blog/malicious-chrome-extensions-steal-chatgpt-deepseek-conversations/",
        what: "collected AI chats",
      },
      {
        id: "inhcgfpbfdjbjogdfjbclgolkmhnooop",
        store: "Chrome",
        name: "AI Sidebar with Deepseek, ChatGPT, Claude and more",
        source: "OX Security",
        date: "2025-12-30",
        url: "https://www.ox.security/blog/malicious-chrome-extensions-steal-chatgpt-deepseek-conversations/",
        what: "collected AI chats",
      },
    ],
  };
})();
