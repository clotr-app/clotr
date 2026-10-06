// The command check: does a command someone copied from an AI chat look like the "verify you're human: press
// Win+R and paste this" trick? `Clotr.commandTrick(copied, around)` returns `{ shape: "download" }` when it
// downloads something and runs it, `{ shape: "hidden" }` when it hides what it runs, or null otherwise.
// `copied` is what you copied, and `around` is the message it came from, read up to 4,000 characters.
// A plain download only counts alongside a trick signal, like the Run keys or a fake "are you human" check; an
// encoded command, or decoded text fed to a shell, counts on its own since those have no legitimate use here.
// A hidden window alone doesn't count, since backup and logon scripts use that too, but it does alongside a
// download or a trick signal. This file is pure, with no page, storage, or browser call, and every pattern
// reads the text in one pass with look-ahead bounded to one line, so a long page can't make it slow.
(() => {
  "use strict";

  const C = (globalThis.Clotr = globalThis.Clotr || {});
  const MAX_AROUND = 4000;

  // Lowercases the text and normalizes curly quotes, unusual spaces, and a line continued with a trailing
  // backslash or backtick, so they all read the same way.
  function plain(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u00a0\u2002-\u200a\u202f\u3000]/g, " ")
      .replace(/[\\`]\r?\n/g, " ")
      .toLowerCase();
  }

  // ---------- Shapes (in what was copied) ----------

  // PowerShell that fetches something and runs it (or runs it with the safety setting off).
  const PS_FETCH = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring|downloadfile|net\.webclient)\b/;
  const PS_RUN = /\b(?:iex|invoke-expression)\b|[-/](?:ep|ex[a-z]*)\s+["']?bypass\b/;
  // Windows programs given an address to fetch from.
  const FETCHERS = [
    /\bmshta(?:\.exe)?\b[^\n]{0,200}?(?:https?:\/\/|\\\\\w)/,
    /\bcertutil(?:\.exe)?\b[^\n]{0,200}?[-/]urlcache\b/,
    /\bbitsadmin(?:\.exe)?\b[^\n]{0,200}?\/transfer\b/,
    /\bmsiexec(?:\.exe)?\b[^\n]{0,200}?(?:https?:\/\/|\\\\\w)/,
    /\brundll32(?:\.exe)?\b[^\n]{0,200}?(?:https?:\/\/|\\\\\w)/,
  ];
  // A shell starting the next part of a pipe, as in "| sh" or "| sudo bash".
  const SHELL = /^\s*(?:sudo\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\b/;
  // A shell running whatever a $(…) or <(…) gives it, as in bash -c "$(…)".
  const SHELL_FED = /\b(?:(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*["']?[$<]\(|eval\s+["']?\$\()/;
  const CURL = /\b(?:curl|wget)\b/;
  const BASE64_DECODE = /\bbase64\s+(?:-d|--decode)\b/;
  const POWERSHELL = /\b(?:powershell|pwsh)(?:\.exe)?\b/;
  const ENCODED = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,300}?\s[-/]e(?:c|n[a-z]*)?\s+["']?[a-z0-9+/]{16,}/;
  const HIDDEN_WINDOW = /(?:^|[\s"'])[-/]w(?:indowstyle|indow|in|i)?\s+["']?hidden\b/;
  const OSASCRIPT_CURL = /\bosascript\b[^\n]{0,300}?\bcurl\b/;

  // Splits a line into its pipes, each a list of the parts between "|", with "||" ending one pipe and
  // starting the next.
  function pipes(line) {
    const out = [[]];
    for (const part of line.split("|")) {
      if (!part.length && out[out.length - 1].length) out.push([]);
      else out[out.length - 1].push(part);
    }
    return out;
  }

  // Checks whether one line downloads and runs something, by piping or feeding curl or wget to a shell, or
  // feeds decoded text to a shell instead.
  function lineShapes(line) {
    let download = false;
    let hidden = false;
    const fed = SHELL_FED.test(line);
    const decodes = BASE64_DECODE.test(line);
    if (fed && CURL.test(line)) download = true;
    if (fed && decodes) hidden = true;
    for (const parts of pipes(line)) {
      let fetched = false;
      let decoded = false;
      for (let i = 0; i < parts.length; i++) {
        if (i && SHELL.test(parts[i])) {
          if (fetched) download = true;
          if (decoded) hidden = true;
        }
        if (CURL.test(parts[i])) fetched = true;
        if (BASE64_DECODE.test(parts[i])) decoded = true;
      }
    }
    return { download, hidden };
  }

  // Finds the shapes in a copied command. `hidden` counts on its own; `hiddenWindow` only counts alongside a
  // download or a trick signal.
  function commandShapes(copied) {
    const text = plain(copied);
    let download = PS_FETCH.test(text) && PS_RUN.test(text);
    let hidden = ENCODED.test(text) || OSASCRIPT_CURL.test(text);
    if (!download) download = FETCHERS.some((re) => re.test(text));
    for (const line of text.split(/\r?\n/)) {
      if (download && hidden) break;
      const s = lineShapes(line);
      download ||= s.download;
      hidden ||= s.hidden;
    }
    const hiddenWindow = HIDDEN_WINDOW.test(text) && (POWERSHELL.test(text) || /\bstart-process\b/.test(text));
    return { download, hidden, hiddenWindow };
  }

  // ---------- Trick signals (in what was copied and the message around it) ----------

  const SIGNALS = [
    // The Run keys and the Run box (English and Spanish).
    /\bwin(?:dows)?(?:\s*(?:logo\s+)?key)?\s*(?:\+|plus)\s*["']?r\b/,
    /\u229e\s*(?:win(?:dows)?\s*)?\+?\s*r\b/,
    /\brun\s+(?:box|dialog|window)\b/,
    /\b(?:abre|abrir|abra|cuadro(?:\s+de\s+di[aá]logo)?|ventana)\s+(?:de\s+)?["'«]?ejecutar\b/,
    // A fake check that you're a person.
    /\b(?:verify|prove|confirm)\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:a\s+)?(?:human|not\s+a\s+robot)\b/,
    /\bnot\s+a\s+robot\b/,
    /\b(?:re|h)?captcha\b/,
    /\b(?:human\s+verification|verification\s+step)\b/,
    /\b(?:verifica|verificar|demuestra|demostrar|confirma|confirmar|comprueba|comprobar)\s+que\s+(?:no\s+)?eres\s+(?:un\s+|una\s+)?(?:humano|humana|persona|robot)\b/,
    /\bno\s+(?:soy|eres)\s+un\s+robot\b/,
    /\bpaso\s+de\s+verificaci[oó]n\b/,
    // A message that claims to come from a company's support (shared chats "Shared by Apple Support").
    /\bshared\s+by\s+(?:[^\s.,;:]+\s+){0,3}?(?:support|help\s*desk)\b/,
    /\bcompartido\s+por\s+(?:el\s+)?(?:equipo\s+de\s+)?soporte\b/,
  ];

  const hasTrickSignal = (text) => SIGNALS.some((re) => re.test(text));

  function commandTrick(copied, around) {
    if (typeof copied !== "string" || !copied.trim()) return null;
    const shapes = commandShapes(copied);
    if (shapes.hidden) return { shape: "hidden" };
    if (!shapes.download && !shapes.hiddenWindow) return null;
    const words = `${plain(copied)}\n${plain(typeof around === "string" ? around.slice(0, MAX_AROUND) : "")}`;
    if (shapes.hiddenWindow && (shapes.download || hasTrickSignal(words))) return { shape: "hidden" };
    if (shapes.download && hasTrickSignal(words)) return { shape: "download" };
    return null;
  }

  C.commandTrick = commandTrick;
  C.commandShapes = commandShapes;
})();
