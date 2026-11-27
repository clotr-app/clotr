// Bandage's labels, like [Phone 1] or [Me], in every language Clotr speaks, and reading them back out of a text.
// content.js writes and reads them through globalThis.Clotr.
(() => {
  "use strict";

  // ---------- Bandage's labels, like [Phone 1], [Me] or [born in the 1940s], in every language Clotr speaks ----------
  // content.js writes labels in the browser's language and reads back a conversation's labels after a reload, so
  // numbering continues and one label never stands for two details. The words are the `bl_*` _locales messages
  // (English first), and the unit tests keep the two in sync.
  const BANDAGE_WORDS = {
    bl_me: ["Me", "Yo"],
    bl_company: ["My company", "Mi empresa"],
    bl_family: ["Family", "Familiar"],
    bl_address: ["Address", "Dirección"],
    bl_phone: ["Phone", "Teléfono"],
    bl_email: ["Email", "Correo"],
    bl_birth: ["Birth date", "Fecha de nacimiento"],
    bl_card: ["Card", "Tarjeta"],
    bl_account: ["Account", "Cuenta"],
    bl_ip: ["IP address", "Dirección IP"],
    bl_term: ["Term", "Término"],
    bl_id: ["ID"],
  };
  const BANDAGE_BORN_IN = ["born in the $1s", "nacimiento en los años $1"];
  const BANDAGE_ALONE = new Set(["bl_me", "bl_company"]); // "[Me]", not "[Me 1]", the first time
  // Case, accents and spacing are loose: an AI may write "[telefono 2]" for "[Teléfono 2]".
  const plainWord = (word) => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
  const looseWord = (word) =>
    word
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+")
      .replace(/[áéíóúñ]/g, (letter) => `[${letter}${plainWord(letter)}]`);
  const BANDAGE_KIND = new Map(
    Object.entries(BANDAGE_WORDS).flatMap(([kind, words]) => words.map((word) => [plainWord(word), kind])),
  );
  // Matches "[word 2]", checking the longest word first so "Dirección IP" wins over "Dirección", or a decade
  // label with its year captured in a group.
  const BANDAGE_WORD_ALTS = Object.values(BANDAGE_WORDS)
    .flat()
    .sort((a, b) => b.length - a.length)
    .map(looseWord)
    .join("|");
  const BANDAGE_BORN_ALTS = BANDAGE_BORN_IN.map((label) => looseWord(label).replace("\\$1", "(\\d{4})")).join("|");
  const BANDAGE_LABEL_RE = new RegExp(
    `\\[\\s*(?:(${BANDAGE_WORD_ALTS})(?:\\s+(\\d{1,4}))?|${BANDAGE_BORN_ALTS})\\s*\\]`,
    "giu",
  );

  // A team's own kinds get covered with their own word, like "[Matter 1]". A word numbers under its own kind,
  // "team:matter", unless it's actually one of Bandage's words in any language, like "Phone" mapping to
  // "bl_phone", so one label never ends up standing for two different details.
  const bandageKindOf = (word) => BANDAGE_KIND.get(plainWord(word)) || `team:${plainWord(word)}`;
  // Matches "[word 2]" with any word up to 40 characters long, though only the words belonging to kinds set
  // through the vault actually count. The pattern itself is static, so nothing a team writes can ever change
  // what it matches. The word can't start with a space, so the spaces after "[" are only ever read one way:
  // otherwise a "[" before a long run of spaces would take time growing with the square of that run.
  const OWN_LABEL_RE = /\[\s*([^[\]\d\s][^[\]\d\n]{0,39}?)\s+(\d{1,4})\s*\]/gu;
  let coverKinds = { list: null, words: new Map() }; // the cover words of the kinds set with the vault, read once
  function teamCovers() {
    const list = globalThis.Clotr.vaultKinds?.() || [];
    if (coverKinds.list !== list) {
      const words = new Map();
      for (const vaultKind of list) {
        const kind = bandageKindOf(vaultKind.cover);
        if (kind.startsWith("team:")) words.set(plainWord(vaultKind.cover), kind);
      }
      coverKinds = { list, words };
    }
    return coverKinds.words;
  }

  // Finds every Bandage label in `text` and returns { label (as written), index, kind (the bl_* key), n, id }.
  // `id` stays the same for one label across any language or case, so "[Phone 2]" and "[teléfono 2]" both
  // become "bl_phone 2". This makes one pass over the text for the built-in words, plus one more for a team's
  // own cover words when there are any.
  function readBandageLabels(text) {
    const out = [];
    if (!text || !text.includes("[")) return out;
    const covers = teamCovers();
    if (covers.size) {
      OWN_LABEL_RE.lastIndex = 0;
      for (let m = OWN_LABEL_RE.exec(text); m; m = OWN_LABEL_RE.exec(text)) {
        const kind = covers.get(plainWord(m[1].trim()));
        const n = Number(m[2]);
        if (kind && n) out.push({ label: m[0], index: m.index, kind, n, id: `${kind} ${n}` });
      }
    }
    BANDAGE_LABEL_RE.lastIndex = 0;
    for (let m = BANDAGE_LABEL_RE.exec(text); m; m = BANDAGE_LABEL_RE.exec(text)) {
      const decade = m.slice(3).find(Boolean);
      if (decade) {
        out.push({ label: m[0], index: m.index, kind: "bl_bornIn", n: 0, id: `bl_bornIn ${decade}` });
        continue;
      }
      const kind = BANDAGE_KIND.get(plainWord(m[1]));
      const n = m[2] ? Number(m[2]) : BANDAGE_ALONE.has(kind) ? 1 : 0;
      if (kind && n) out.push({ label: m[0], index: m.index, kind, n, id: `${kind} ${n}` });
    }
    return covers.size ? out.sort((a, b) => a.index - b.index) : out;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    BANDAGE_WORDS,
    BANDAGE_BORN_IN,
    bandageKindOf,
    readBandageLabels,
  };
})();
