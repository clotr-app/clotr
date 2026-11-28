(() => {
  "use strict";

  // ---------- Automatic spotting (browser-side, no page access needed) ----------

  // chrome.declarativeContent lets the browser itself check a page against these rules and light up Clotr's
  // icon, without Clotr ever reading or running on the page. A page counts as spotted once its address has
  // AI wording and it has something that looks like a prompt box.

  // Written in RE2 syntax, since declarativeContent doesn't support lookarounds. "ai" only counts as a
  // whole label or TLD, so mail.google.com doesn't match. gpt, llm, copilot and assistant can appear
  // anywhere.
  const AI_URL_REGEX = "^https://(([^/]*[.-])?ai([.-][^/]*)?|[^/]*(gpt|llm|copilot|assistant)[^/]*)/";

  // declarativeContent only supports simple selectors, so these match on fragments instead of whole words.
  // "sk " catches both "Ask" and "ask", and "essage" catches both "Message" and "message".
  const PROMPT_SELECTORS = [
    'textarea[placeholder*="sk "]',
    'textarea[placeholder*="nything"]',
    'textarea[placeholder*="essage"]',
    'textarea[placeholder*="rompt"]',
    'textarea[aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="essage"]',
    '[contenteditable="true"][data-placeholder]',
    'div.ProseMirror[contenteditable="true"]',
  ];

  // ---------- On-demand check (popup, via activeTab) ----------

  // Only runs in the current tab, and only once someone opens the popup there. It has to be self-contained,
  // since it gets serialized and run inside the page itself. So every helper it uses lives inside it.
  function inspectPageForAIChat() {
    const AI_WORDS =
      /\b(ai|a\.i\.|gpt|llm|chatbot|copilot|assistant|claude|gemini|mistral|llama|deepseek|perplexity|grok|qwen|kimi|language model)\b/i;
    const AI_HOST = /(^|[.-])ai([.-]|$)|gpt|llm|copilot|assistant/i;
    const PROMPT_WORDS = /ask|message|prompt|anything|question|describe|chat|type/i;
    const SEND_BUTTON = 'button[aria-label*="send" i], button[aria-label*="submit" i], button[data-testid*="send" i]';
    // A form built for an address, a payment card, a sign-in or someone's name.
    const FORM_FIELD_AUTOCOMPLETE =
      /^(street-address|address-line[1-3]|address-level[1-4]|postal-code|country(-name)?|organization|cc-[a-z-]+|name|given-name|additional-name|family-name|honorific-(prefix|suffix)|nickname|email|tel(-[a-z-]+)?|username|current-password|new-password)$/i;
    const SEND_LIKE = /\b(send|enviar)\b/i; // English and Spanish, Clotr's two languages

    const host = location.hostname;
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const meta = description?.content || "";
    const signals = [];

    if (AI_HOST.test(host)) signals.push("AI wording in the address");
    if (AI_WORDS.test(`${document.title} ${meta}`)) signals.push("AI wording in the page title");

    const editable = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
    const inputs = [...editable].filter(isVisible);
    const promptBox = inputs.some((input) => PROMPT_WORDS.test(describe(input)));
    if (promptBox) signals.push("a chat-style prompt box");
    if (document.querySelector(SEND_BUTTON)) signals.push("a send button");

    // Catches a white-labeled AI chat with no "ai" anywhere in its own address or title, which the two
    // wording checks above both miss.
    const chatShape = inputs.some(hasComposerShape);
    if (chatShape) signals.push("a chat-shaped box");

    const aiWording = signals.some((signal) => signal.startsWith("AI wording"));
    // A prompt box alone could be any messaging app, so that still needs AI wording too. A box that actually
    // has a chat's shape is a stronger signal on its own, the same way "Everywhere I type" trusts it without
    // any wording at all. It still only leads to the once-only offer, never anything built in.
    return { looksLikeAI: (promptBox && aiWording) || chatShape, signals };

    function isVisible(element) {
      const box = element.getBoundingClientRect();
      return box.width > 150 && box.height > 16;
    }

    function describe(element) {
      return [
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.getAttribute("data-placeholder"),
        (element.textContent || "").slice(0, 120),
      ].join(" ");
    }

    // A chat-shaped box, the same rule on-websites/chat-box.js's isChatComposer uses for "Everywhere I type": a multi-line
    // box with a send-like control or enterkeyhint="send" nearby, never one sitting in a form built for an
    // address, a payment card, a sign-in or someone's name. It's a small copy of that check rather than a
    // reuse of it, since this function runs inside a page Clotr's other scripts never touch.
    function hasComposerShape(element) {
      const form = typeof element.closest === "function" ? element.closest("form") : null;
      if (form?.querySelector("input[type='password']")) return false;
      if (isPersonalDetailsForm(form)) return false;
      if ((element.getAttribute("enterkeyhint") || "").toLowerCase() === "send") return true;
      return hasSendButtonNearby(element);
    }

    function isPersonalDetailsForm(form) {
      if (!form) return false;
      const fields = [...form.querySelectorAll("[autocomplete]")];
      const hints = fields.map((field) => field.getAttribute("autocomplete") || "");
      return hints.some((hint) => FORM_FIELD_AUTOCOMPLETE.test(hint.trim()));
    }

    // Looks up to four parents out from the box for a button that reads like "send".
    function hasSendButtonNearby(element) {
      let area = element;
      for (let level = 0; level < 4 && area?.parentElement; level++) {
        area = area.parentElement;
        for (const button of area.querySelectorAll('button, [role="button"], input[type="submit"]')) {
          if (button === element || button.contains(element)) continue;
          if (SEND_LIKE.test(buttonLabel(button))) return true;
        }
      }
      return false;
    }

    function buttonLabel(button) {
      const ariaLabel = button.getAttribute("aria-label") || "";
      const title = button.getAttribute("title") || "";
      return `${ariaLabel} ${title} ${button.textContent || ""}`;
    }
  }

  // ---------- Health text ----------

  // What the popup tells you about a protected tab, based on what that tab's content script already reported
  // to the background. The level is one of on, idle, warn or paused.
  // `builtIn` is only used for the last line. On one of Clotr's own AI sites, a redesign that moved its chat
  // box far enough that even the shape rule (on-websites/content.js's fallback for built-in sites) misses it still means
  // something can be sent there, since typing itself is checked the moment it happens, not just the
  // look-before-you-type scan behind this line.
  function healthText({
    running = false,
    paused = false,
    editor = false,
    editFailed = false,
    uiRemoved = false,
    builtIn = false,
  } = {}) {
    if (!running) {
      return {
        level: "warn",
        key: "hc_notRunning",
        text: "Clotr isn't running in this tab yet. Reload the page to start it.",
      };
    }
    if (paused) return { level: "paused", key: "hc_paused", text: "Paused on this site" };
    if (uiRemoved) {
      return {
        level: "warn",
        key: "hc_uiRemoved",
        text: "This page removed Clotr's warnings, so Clotr can't warn you here. Messages are never held on this page.",
      };
    }
    if (editFailed) {
      return {
        level: "warn",
        key: "hc_editFailed",
        text: "Clotr couldn't edit the chat box here last time. Delete flagged details by hand before sending.",
      };
    }
    if (editor) return { level: "on", key: "hc_watching", text: "Protecting this site: watching the chat box ✓" };
    if (builtIn) {
      return {
        level: "idle",
        key: "hc_noBoxBuiltIn",
        text: "Clotr can't find the chat box on this page. Copy and paste is still checked when you send.",
      };
    }
    return { level: "idle", key: "hc_noBox", text: "Protecting this site: no chat box on this page yet" };
  }

  Object.assign(globalThis.ClotrSites, {
    healthText,
    AI_URL_REGEX,
    PROMPT_SELECTORS,
    inspectPageForAIChat,
  });
})();
