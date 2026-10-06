// Tests for extension/decide.js, the module that decides what to do with a detail Clotr finds and what the warning
// says about it. It's pure and shared by the content scripts, the background script and every other host, so the
// answer and the wording stay the same everywhere Clotr runs.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");
require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
const C = globalThis.Clotr;

const SALT = "0123456789abcdef0123456789abcdef";
const PHONE = "555-555-5636";
const fp = (type, value) => C.fingerprint(SALT, type, value);
const found = (id, matches, extra = {}) => ({
  id,
  name: C.PATTERNS.find((p) => p.id === id)?.name || id,
  severity: "medium",
  matches,
  ...extra,
});
// A host's state: the salt, the vault, each kind's response, the site's or app's mode, and a cache for vaultMode.
const state = (extra = {}) => ({ salt: SALT, vault: [], responses: {}, siteMode: null, cache: new Map(), ...extra });
const valueEntry = (type, value, mode) => ({ kind: "value", type, fp: fp(type, value), mode, added: 1 });

test("loads with no page, no storage and no browser: patterns, detector and decide in a bare script context", () => {
  const context = vm.createContext({});
  for (const f of ["patterns.js", "detector.js", "decide.js"])
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), context, { filename: f });
  const out = vm.runInContext(
    `(() => {
      const C = globalThis.Clotr;
      const s = { salt: null, vault: [], responses: { phone_number: "block" }, siteMode: null };
      const r = C.detect("call me at ${PHONE}")[0];
      return { resp: C.respFor(r, r.matches[0], s), mask: C.mask(r.matches[0]), words: C.noticeWords([r]) };
    })()`,
    context,
  );
  assert.equal(out.resp, "block");
  assert.equal(out.mask, "555-…36");
  assert.deepEqual(JSON.parse(JSON.stringify(out.words)), {
    lead: "Your message contains ",
    items: ["Phone Number (555-…36)"],
    tail: ". If you send it, this AI gets it.",
  });
});

test("mask: 8 characters or fewer are all dots; longer shows the first four, an ellipsis and the last two", () => {
  assert.equal(C.mask(""), "");
  assert.equal(C.mask("1234"), "••••");
  assert.equal(C.mask("12345678"), "••••••••");
  assert.equal(C.mask("123456789"), "1234…89");
  assert.equal(C.mask("AKIA4HPQ7XZ2R6TWLJ3N"), "AKIA…3N");
});

test("describeValues: up to three masked values; more get a count and the first three", () => {
  assert.equal(C.describeValues(found("phone_number", [PHONE])), "555-…36");
  assert.equal(C.describeValues(found("email", ["a@b.co", "jo@example.org"])), "••••••, jo@e…rg");
  assert.equal(
    C.describeValues(found("phone_number", ["111-555-0001", "222-555-0002", "333-555-0003", "444-555-0004"])),
    "×4: 111-…01, 222-…02, 333-…03, …",
  );
});

test("responseOf: the kind's own response, the old 'off' as just count, and this site's mode over both", () => {
  assert.equal(C.responseOf("phone_number", state()), "warn");
  assert.equal(C.responseOf("phone_number", state({ responses: { phone_number: "block" } })), "block");
  assert.equal(C.responseOf("phone_number", state({ responses: { phone_number: "off" } })), "log");
  assert.equal(C.responseOf("license_plate", state()), "log", "a kind that starts quietly");
  assert.equal(C.responseOf("phone_number", state({ responses: { phone_number: "log" }, siteMode: "block" })), "block");
  assert.equal(C.responseOf("phone_number", state({ responses: { phone_number: "block" }, siteMode: "log" })), "log");
});

test("respFor: the vault adjusts the kind's response; allow only counts, protect lifts just-count and never lowers", () => {
  const r = found("phone_number", [PHONE]);
  // With no vault entry, the result just follows the kind's own response.
  assert.equal(C.respFor(r, PHONE, state()), "warn");
  assert.equal(C.respFor(r, PHONE, state({ responses: { phone_number: "block" } })), "block");
  // Marking a value "OK to share" downgrades it to just a count, no matter what the kind says.
  const allow = { vault: [valueEntry("phone_number", PHONE, "allow")] };
  assert.equal(C.respFor(r, PHONE, state(allow)), "log");
  assert.equal(C.respFor(r, PHONE, state({ ...allow, responses: { phone_number: "block" } })), "log");
  // Marking a value "protect" raises a just-count kind to a warning, but leaves warn and block as they are.
  const protect = { vault: [valueEntry("phone_number", PHONE, "protect")] };
  assert.equal(C.respFor(r, PHONE, state({ ...protect, responses: { phone_number: "log" } })), "warn");
  assert.equal(C.respFor(r, PHONE, state(protect)), "warn");
  assert.equal(C.respFor(r, PHONE, state({ ...protect, responses: { phone_number: "block" } })), "block");
  assert.equal(C.respFor(r, PHONE, state({ ...protect, siteMode: "log" })), "warn", "protect lifts a quiet site too");
  // A different number of the same kind isn't in the vault, so it keeps the kind's own response.
  assert.equal(C.respFor(r, "614-555-0199", state({ ...allow, responses: { phone_number: "block" } })), "block");
  // With no salt nothing can be matched against the vault, so it falls back to the kind's response.
  assert.equal(C.respFor(r, PHONE, state({ ...allow, salt: null })), "warn");
});

test("vaultMode: protect, allow or nothing; hashed once per value, the cache kept to 2,000", () => {
  const s = state({
    vault: [valueEntry("phone_number", PHONE, "protect"), valueEntry("email", "jo@example.org", "allow")],
  });
  assert.equal(C.vaultMode("phone_number", PHONE, s), "protect");
  assert.equal(C.vaultMode("phone_number", "(555) 555 5636", s), "protect", "however it's written");
  assert.equal(C.vaultMode("email", "jo@example.org", s), "allow");
  assert.equal(C.vaultMode("email", "someone@example.org", s), null);
  assert.equal(C.vaultMode("email", PHONE, s), null, "a value saved under another kind doesn't count");
  // vaultMode only looks at value entries; words and shapes are matched over in patterns.js instead.
  assert.equal(
    C.vaultMode("phone_number", PHONE, state({ vault: [{ kind: "word", type: "watch_list", fp: "0".repeat(16) }] })),
    null,
  );
  // vaultMode caches its answer, so changing the vault in place only takes effect once the host clears the
  // cache, which it does on every settings change.
  s.vault[0].mode = "allow";
  assert.equal(C.vaultMode("phone_number", PHONE, s), "protect");
  s.cache.clear();
  assert.equal(C.vaultMode("phone_number", PHONE, s), "allow");
  // The cache stays capped, so a tab left open all day doesn't grow forever.
  const big = state({ vault: [valueEntry("phone_number", PHONE, "protect")] });
  for (let i = 0; i < 2000; i++) C.vaultMode("phone_number", `555-01${String(i).padStart(4, "0")}`, big);
  assert.equal(big.cache.size, 2000);
  C.vaultMode("phone_number", PHONE, big);
  assert.equal(big.cache.size, 1);
  // A host doesn't have to keep a cache at all.
  assert.equal(
    C.vaultMode("phone_number", PHONE, { salt: SALT, vault: [valueEntry("phone_number", PHONE, "allow")] }),
    "allow",
  );
});

test("vaultMode: an address saved before 0.9.68 kept its accents in the fingerprint, and still matches as typed", () => {
  const typed = "Calle Alcalá 45";
  const old = { kind: "value", type: "street_address", fp: fp("street_address_accented", typed), mode: "allow" };
  assert.equal(C.vaultMode("street_address", typed, state({ vault: [old] })), "allow");
  assert.equal(C.vaultMode("street_address", "Calle Mayor 1", state({ vault: [old] })), null);
});

test("splitOwnIds: with your own ID in the vault, IDs that only share its format are named apart and rank lower", () => {
  const ids = found("my_id", ["EMP-48213", "EMP-11111"], { name: "Your Account/ID Number", severity: "high" });
  const phone = found("phone_number", [PHONE]);
  // With no ID of yours in the vault, the results come back unchanged.
  const plain = [ids, phone];
  assert.equal(C.splitOwnIds(plain, state()), plain);
  assert.equal(
    C.splitOwnIds(plain, state({ vault: [valueEntry("my_id", "EMP-48213", "protect")], salt: null })),
    plain,
  );
  const s = state({ vault: [valueEntry("my_id", "EMP-48213", "protect")] });
  assert.deepEqual(C.splitOwnIds(plain, s), [
    { ...ids, matches: ["EMP-48213"] },
    { ...ids, matches: ["EMP-11111"], name: "Account/ID Number", severity: "medium" },
    phone,
  ]);
  // Works the same with only someone else's ID, or only your own.
  assert.deepEqual(C.splitOwnIds([{ ...ids, matches: ["EMP-11111"] }], s), [
    { ...ids, matches: ["EMP-11111"], name: "Account/ID Number", severity: "medium" },
  ]);
  assert.deepEqual(C.splitOwnIds([{ ...ids, matches: ["EMP-48213"] }], s), [{ ...ids, matches: ["EMP-48213"] }]);
});

// Loads the Spanish messages file and fills in its placeholders the way chrome.i18n.getMessage would.
function withSpanish(fn) {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const getMessage = (key, subs = []) =>
    es[key]?.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, n) => subs[Number(es[key].placeholders[n].content[1]) - 1]) ||
    "";
  globalThis.chrome = { i18n: { getMessage } };
  try {
    return fn(es);
  } finally {
    delete globalThis.chrome;
  }
}

test("noticeWords: the warning's sentence for an AI, for people (email and chat apps) and for copied text", () => {
  const results = [found("phone_number", [PHONE]), found("email", ["jo@example.org", "a@b.co"])];
  const items = ["Phone Number (555-…36)", "Email Address (jo@e…rg)", "Email Address (••••••)"];
  assert.deepEqual(C.noticeWords(results), {
    lead: "Your message contains ",
    items,
    tail: ". If you send it, this AI gets it.",
  });
  assert.deepEqual(C.noticeWords(results, { everyday: true }), {
    lead: "Your message contains ",
    items,
    tail: ". If you send it, the people who read it here get it.",
  });
  assert.deepEqual(C.noticeWords(results, { source: "copied" }), {
    lead: "What you copied contains ",
    items,
    tail: ". If you paste it here, this AI app gets it.",
  });
  assert.deepEqual(C.noticeWords(results, { source: "copied", everyday: true }), {
    lead: "What you copied contains ",
    items,
    tail: ". If you paste it here, the people who read it get it.",
  });
  assert.deepEqual(C.noticeWords([]), {
    lead: "Your message contains ",
    items: [],
    tail: ". If you send it, this AI gets it.",
  });
});

test("noticeWords: the same sentence in Spanish, from the same messages", () => {
  withSpanish((es) => {
    const results = [found("phone_number", [PHONE], { name: "Número de teléfono" })];
    const items = ["Número de teléfono (555-…36)"];
    assert.deepEqual(C.noticeWords(results), {
      lead: es.noticeContains.message,
      items,
      tail: es.noticeShared.message,
    });
    assert.equal(C.noticeWords(results).lead, "Tu mensaje contiene ");
    assert.equal(C.noticeWords(results, { everyday: true }).tail, es.noticeSharedHere.message);
    assert.deepEqual(C.noticeWords(results, { source: "copied" }), {
      lead: "Lo que copiaste contiene ",
      items,
      tail: ". Si lo pegas aquí, esta app de IA lo recibe.",
    });
    assert.equal(
      C.noticeWords(results, { source: "copied", everyday: true }).tail,
      ". Si lo pegas aquí, quienes lo lean lo reciben.",
    );
  });
});

test("cleanVaultEntry: only well-formed entries, so nothing else (least of all a raw value) is ever stored", () => {
  const now = Date.now();
  // None of these are even an entry.
  for (const bad of [null, undefined, 0, "x", [], {}]) assert.equal(C.cleanVaultEntry(bad), null, JSON.stringify(bad));
  // An unrecognized kind or type is rejected too.
  assert.equal(C.cleanVaultEntry({ kind: "secret", type: "phone_number", fp: "0123456789abcdef" }), null);
  assert.equal(C.cleanVaultEntry({ kind: "value", type: "Phone-Number", fp: "0123456789abcdef" }), null);
  assert.equal(C.cleanVaultEntry({ kind: "value", type: "x", fp: "0123456789abcdef" }), null);
  assert.equal(C.cleanVaultEntry({ kind: "value", type: 7, fp: "0123456789abcdef" }), null);
  // A value or word entry must carry a 16-character fingerprint, never the raw value.
  assert.equal(C.cleanVaultEntry({ kind: "value", type: "phone_number", fp: PHONE }), null);
  assert.equal(C.cleanVaultEntry({ kind: "value", type: "phone_number", fp: "0123456789ABCDEF" }), null);
  assert.equal(C.cleanVaultEntry({ kind: "word", type: "watch_list", fp: "0123456789abcde" }), null);
  // A value entry defaults to "protect" unless it says "allow", and anything else on it is dropped.
  assert.deepEqual(
    C.cleanVaultEntry({ kind: "value", type: "phone_number", fp: "0123456789abcdef", added: 5, value: PHONE }),
    { kind: "value", type: "phone_number", added: 5, fp: "0123456789abcdef", mode: "protect" },
  );
  assert.equal(
    C.cleanVaultEntry({ kind: "value", type: "email", fp: "0123456789abcdef", mode: "allow" }).mode,
    "allow",
  );
  assert.equal(
    C.cleanVaultEntry({ kind: "value", type: "email", fp: "0123456789abcdef", mode: "block" }).mode,
    "protect",
  );
  // A word entry can watch for one to four words.
  const word = (words) => C.cleanVaultEntry({ kind: "word", type: "watch_list", fp: "0123456789abcdef", words });
  assert.equal(word(undefined).words, 1);
  assert.equal(word(3).words, 3);
  assert.equal(word(9).words, 4);
  assert.equal(word(-2).words, 1);
  assert.equal(word(2).mode, undefined, "a word has no mode");
  // A shape entry needs at least two placeholder marks, no digits, and 40 characters at most.
  assert.deepEqual(C.cleanVaultEntry({ kind: "shape", type: "my_id", shape: "EMP-#####", added: 2 }), {
    kind: "shape",
    type: "my_id",
    added: 2,
    shape: "EMP-#####",
  });
  assert.equal(C.cleanVaultEntry({ kind: "shape", type: "my_id", shape: "EMP-4####" }), null, "a digit");
  assert.equal(C.cleanVaultEntry({ kind: "shape", type: "my_id", shape: "EMP-#" }), null, "one mark");
  assert.equal(C.cleanVaultEntry({ kind: "shape", type: "my_id", shape: `${"A".repeat(39)}##` }), null, "too long");
  assert.equal(C.cleanVaultEntry({ kind: "shape", type: "my_id", shape: 12 }), null);
  // An entry learned from your choices gets "now" if its time is missing or invalid.
  assert.equal(
    C.cleanVaultEntry({ kind: "word", type: "watch_list", fp: "0123456789abcdef", learned: 1 }).learned,
    true,
  );
  const added = C.cleanVaultEntry({ kind: "word", type: "watch_list", fp: "0123456789abcdef", added: "soon" }).added;
  assert.ok(added >= now && added <= Date.now());
});

test("vaultKey and dedupeVault: one entry per fingerprint, and per format whatever its case", () => {
  const a = { kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "protect" };
  const b = { ...a, mode: "allow" };
  const c = { kind: "shape", type: "my_id", shape: "EMP-#####" };
  const d = { kind: "shape", type: "my_id", shape: "emp-#####" };
  assert.equal(C.vaultKey(a), "value:phone_number:0123456789abcdef");
  assert.equal(C.vaultKey(c), "shape:my_id:emp-#####");
  assert.deepEqual(C.dedupeVault([a, b, c, d]), [a, c]);
  assert.deepEqual([...C.VAULT_MODES], ["protect", "allow"]);
});

test("cleanEvent: an event keeps only its known fields, a fingerprint or nothing, never a value", () => {
  const e = {
    t: 1727800000000,
    site: "chatgpt.com",
    type: "phone_number",
    name: "Phone Number",
    severity: "medium",
    action: "redacted",
    fp: "0123456789abcdef",
  };
  assert.deepEqual(C.cleanEvent(e), e);
  assert.deepEqual(C.cleanEvent({ ...e, via: "bandage" }), { ...e, via: "bandage" });
  assert.deepEqual(C.cleanEvent({ ...e, via: "elsewhere", value: PHONE, text: `call ${PHONE}` }), e);
  assert.equal(C.cleanEvent({ ...e, fp: PHONE }).fp, "", "a value where the fingerprint goes is dropped");
  for (const action of ["redacted", "allowed", "suppressed", "mentioned"])
    assert.equal(C.cleanEvent({ ...e, action }).action, action);
  assert.equal(C.cleanEvent({ ...e, action: "sent" }), null);
  assert.equal(C.cleanEvent({ ...e, severity: "urgent" }), null);
  for (const bad of [null, "x", 5]) assert.equal(C.cleanEvent(bad), null);
  assert.equal(C.cleanEvent({ ...e, site: "a".repeat(300) }).site.length, 253);
  assert.equal(C.cleanEvent({ ...e, type: 5, name: { x: 1 } }).type, "");
  const t = C.cleanEvent({ ...e, t: "now" }).t;
  assert.ok(Number.isFinite(t) && t <= Date.now());
});

// ---------- Who really asks for this ----------
// For a card's security code, a gift card's numbers, and five codes scammers ask people to read out, the warning
// adds a question and answer behind "Why am I seeing this?", plus what to do next. Each answer, in English and
// Spanish, is backed by a cited source, or stands on a plain fact about the detail when no source is needed.

const ASKED = {
  card_code: {
    text: "the 3 numbers on the back are 482",
    name: ["Card Security Code", "Código de seguridad de la tarjeta"],
    q: ["Who asks for the 3 numbers on the back of your card?", "¿Quién pide los 3 números de atrás de tu tarjeta?"],
    a: [
      "Not your card company: it already has them. Type them only into a checkout page you opened yourself.",
      "Tu banco no: ya los tiene. Escríbelos solo en una página de pago que abriste tú.",
    ],
    todo: [
      "Don't send them. If they already went to someone, call the number on your card and ask for a new card.",
      "No los envíes. Si ya se los diste a alguien, llama al número de tu tarjeta y pide una nueva.",
    ],
    sources: [
      "https://consumer.georgia.gov/credit-card-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
  },
  gift_card: {
    text: "the gift card code is 7KQ2-9PMX-4RT8",
    name: ["Gift Card Code", "Código de tarjeta regalo"],
    q: ["Who asks for the numbers on a gift card?", "¿Quién pide los números de una tarjeta regalo?"],
    a: [
      "Scammers do. No real business or government agency will ever tell you to pay them with a gift card.",
      "Los estafadores. Ninguna empresa ni organismo público de verdad te pedirá que le pagues con una tarjeta regalo.",
    ],
    todo: [
      "Don't send them. If you already did, call the gift card company on the number on the back of the card and ask for your money back.",
      "No los envíes. Si ya lo hiciste, llama a la empresa de la tarjeta al número que aparece detrás y pide que te devuelvan el dinero.",
    ],
    sources: [
      "https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
  },
  login_code: {
    text: "the code they texted me is 482913",
    name: ["Sign-in Code", "Código de acceso"],
    q: ["Who asks for a code that was sent to you?", "¿Quién pide un código que te enviaron?"],
    a: [
      "Only scammers: with it, they get into your account. No real bank, company or buyer asks for it.",
      "Solo los estafadores: con él entran en tu cuenta. Ningún banco, empresa ni comprador de verdad lo pide.",
    ],
    todo: [
      "Don't send it. If someone called or messaged you for it, hang up and call the number on your card.",
      "No lo envíes. Si alguien te llamó o te escribió para pedirlo, cuelga y llama al número de tu tarjeta.",
    ],
    sources: [
      "https://consumer.ftc.gov/consumer-alerts/2024/03/whats-verification-code-why-would-someone-ask-me-it",
      "https://consumer.ftc.gov/consumer-alerts/2021/10/google-voice-scam-how-verification-code-scam-works-how-avoid-it",
    ],
  },
  remote_code: {
    text: "my AnyDesk code is 123 456 789",
    name: ["Remote-Access Code", "Código de acceso remoto"],
    q: ["Who asks for a code to get into your computer?", "¿Quién pide un código para entrar en tu ordenador?"],
    a: [
      "Fake tech support. Real tech companies don't call or message you about a problem with your computer.",
      "El falso soporte técnico. Las empresas de tecnología de verdad no te llaman ni te escriben por un problema en tu ordenador.",
    ],
    todo: [
      "Don't send it. If you already let someone in, update your security software, run a scan and change your passwords.",
      "No lo envíes. Si ya dejaste entrar a alguien, actualiza tu antivirus, haz un análisis y cambia tus contraseñas.",
    ],
    sources: [
      "https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
  },
  recovery_codes: {
    text: "backup codes are 1234 5678, 2345 6789",
    name: ["Backup Codes", "Códigos de respaldo"],
    q: ["Who asks for your backup codes?", "¿Quién pide tus códigos de respaldo?"],
    a: [
      "Only someone trying to get into your account without you. They're its spare keys.",
      "Solo alguien que quiere entrar en tu cuenta sin ti. Son sus llaves de repuesto.",
    ],
    todo: [
      "Keep them on paper or in your password manager, never in a chat.",
      "Guárdalos en papel o en tu gestor de contraseñas, nunca en un chat.",
    ],
    sources: ["plain fact"],
  },
  security_answer: {
    text: "my mother's maiden name is Smith",
    name: ["Security Answer", "Respuesta de seguridad"],
    q: ["Who asks for your security answers?", "¿Quién pide tus respuestas de seguridad?"],
    a: [
      "They open your account like a password. Someone asking in a chat may be trying to reset yours.",
      "Abren tu cuenta como una contraseña. Quien las pide en un chat puede querer cambiar la tuya.",
    ],
    todo: [
      "Don't send them. If you already did, change the answer in that account's settings.",
      "No las envíes. Si ya lo hiciste, cambia la respuesta en los ajustes de esa cuenta.",
    ],
    sources: ["plain fact"],
  },
  home_code: {
    text: "the gate code is 4821",
    name: ["PIN or Door Code", "PIN o código de puerta"],
    q: ["Who needs your PIN or a door code?", "¿Quién necesita tu PIN o un código de puerta?"],
    a: [
      "Only you, and people you'd give your keys to. Someone who contacted you first and asks for it is likely a scammer.",
      "Solo tú y las personas a las que darías tus llaves. Si te contactaron primero y te lo piden, probablemente es una estafa.",
    ],
    todo: [
      "Don't send it in a chat. If a card's PIN went out, call the number on your card.",
      "No lo envíes por chat. Si enviaste el PIN de una tarjeta, llama al número de tu tarjeta.",
    ],
    sources: ["plain fact"],
  },
};
const askWords = (a) => ({ id: a.id, name: a.name, q: a.q, a: a.a, todo: a.todo });
const expectedAsk = (id, lang) => {
  const w = ASKED[id];
  return { id, name: w.name[lang], q: w.q[lang], a: w.a[lang], todo: w.todo[lang] };
};

test("whoAsks: the list is the two kinds, then the password kind's reasons, in the line's order", () => {
  assert.deepEqual(C.WHO_ASKS, ["card_code", "gift_card", ...C.ASK_REASONS]);
  assert.deepEqual(C.WHO_ASKS, Object.keys(ASKED));
});

test("whoAsks: each kind and reason gets its name, question, answer and what to do, in English", () => {
  for (const [id, w] of Object.entries(ASKED))
    assert.deepEqual(C.whoAsks(C.detect(w.text)).map(askWords), [expectedAsk(id, 0)], w.text);
});

test("whoAsks: the same words in Spanish, from the Spanish messages", () => {
  withSpanish(() => {
    for (const [id, w] of Object.entries(ASKED)) {
      // A kind's name comes from its pattern, and the content script names it in the browser's own language.
      const found = C.detect(w.text).map((r) => (r.id === id ? { ...r, name: w.name[1] } : r));
      assert.deepEqual(C.whoAsks(found).map(askWords), [expectedAsk(id, 1)], w.text);
    }
  });
});

test("whoAsks: each answer carries the source it stands on, or is a plain fact about the detail", () => {
  for (const [id, w] of Object.entries(ASKED)) assert.deepEqual(C.whoAsksFor(id).sources, w.sources, id);
});

test("whoAsks: nothing for a plain password, a key, a card number, an SSN or a phone number", () => {
  for (const text of [
    "password: hunter2!",
    "AKIA4HPQ7XZ2R6TWLJ3N",
    "my card is 4111 1111 1111 1111",
    "my SSN is 078-05-1121",
    `call me at ${PHONE}`,
    "PIN: 4821",
  ])
    assert.deepEqual(C.whoAsks(C.detect(text)), [], text);
  assert.deepEqual(C.whoAsks([]), []);
});

test("whoAsks: with two, the table's order picks the first; a mix with a plain password still has its code's line", () => {
  const ids = (text) => C.whoAsks(C.detect(text)).map((a) => a.id);
  assert.deepEqual(ids("the gate code is 4821 and the CVV is 123"), ["card_code", "home_code"]);
  assert.deepEqual(ids("the code they texted me is 482913 and the gift card code is 7KQ2-9PMX-4RT8"), [
    "gift_card",
    "login_code",
  ]);
  assert.deepEqual(ids("password: Fluffy123! and the code they texted me is 482913"), ["login_code"]);
});

test("whoAsks: only the codes still listed count, so a code already left in leaves no line behind", () => {
  const mix = C.detect("password: Fluffy123! and the code they texted me is 482913");
  const left = mix.map((r) => ({ ...r, matches: r.matches.filter((m) => m !== "482913") }));
  assert.deepEqual(C.whoAsks(left), []);
  const code = mix.map((r) => ({ ...r, matches: r.matches.filter((m) => m === "482913") }));
  assert.deepEqual(
    C.whoAsks(code).map((a) => a.id),
    ["login_code"],
  );
});

test("detect: the password kind knows which reason each code has, in the text as written", () => {
  const r = (text) => C.detect(text).find((x) => x.id === "password");
  assert.equal(r("the code they texted me is 482913").reasonOf.get("482913"), "login_code");
  const hidden = r("the code they texted me is 48​2913");
  assert.deepEqual(hidden.matches, ["48​2913"]);
  assert.equal(hidden.reasonOf.get("48​2913"), "login_code");
  const mix = r("password: Fluffy123! and the gate code is 4821");
  assert.deepEqual([...mix.reasonOf], [["4821", "home_code"]]);
  assert.equal(r("password: hunter2!").reasonOf, undefined);
});

test("asShown: a password result whose every match has a reason is named by it; a mix keeps its kind's name", () => {
  const names = (text) => C.asShown(C.detect(text)).map((r) => [r.id, r.name, r.matches]);
  assert.deepEqual(names("the code they texted me is 482913"), [["password", "Sign-in Code", ["482913"]]]);
  assert.deepEqual(names("the gate code is 4821 and the code they texted me is 482913"), [
    ["password", "Sign-in Code", ["482913"]],
    ["password", "PIN or Door Code", ["4821"]],
  ]);
  assert.deepEqual(names("password: Fluffy123! and the code they texted me is 482913"), [
    ["password", "Password or Secret", ["Fluffy123!", "482913"]],
  ]);
  assert.deepEqual(names("the 3 numbers on the back are 482"), [["card_code", "Card Security Code", ["482"]]]);
  assert.deepEqual(names("password: hunter2!"), [["password", "Password or Secret", ["hunter2!"]]]);
  // If an earlier code was let through, naming only looks at whichever codes remain.
  const mix = C.detect("password: Fluffy123! and the code they texted me is 482913");
  const code = mix.map((r) => ({ ...r, matches: r.matches.filter((m) => m === "482913") }));
  assert.deepEqual(
    C.asShown(code).map((r) => r.name),
    ["Sign-in Code"],
  );
  // asShown never changes the original result, since history keeps the kind and its own name.
  const found = C.detect("the code they texted me is 482913");
  C.asShown(found);
  assert.equal(found[0].name, "Password or Secret");
  assert.deepEqual(C.noticeWords(C.asShown(found)).items, ["Sign-in Code (••••••)"]);
});

test("asShown: the reasons' names in Spanish", () => {
  withSpanish(() => {
    for (const [id, w] of Object.entries(ASKED)) {
      if (!C.ASK_REASONS.includes(id)) continue;
      assert.equal(C.asShown(C.detect(w.text))[0].name, w.name[1], id);
    }
  });
});
