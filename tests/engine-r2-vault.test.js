// The vault's own words, formats and kinds: what detect() finds through them, and that Cover it (redact and
// generalize, and content.js through wordStarts) hides every copy it found, however the text around it is written.
// Run from the repo root: node --test tests/engine-r2-vault.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");

const C = globalThis.Clotr;
const SALT = "s4lt";
// A word saved the way vault.js saves one (detector.js wordEntry): its fingerprint, its count of space-separated
// words and, for a word written in a script without spaces, its count of letters.
const saved = (type, phrase) => C.wordEntry(SALT, type, phrase);
// A word saved before wordEntry kept a count of letters: only its fingerprint and words.
const savedBefore = (type, phrase, form = "watch_list") => ({
  kind: "word",
  type,
  fp: C.fingerprint(SALT, form, phrase),
  words: phrase.split(" ").length,
});

function withVault(entries, fn) {
  C.setVault({ salt: SALT, entries });
  try {
    fn();
  } finally {
    C.setVault(null);
  }
}

const LABEL = { my_name: "[REDACTED YOUR NAME]", family_name: "[REDACTED FAMILY MEMBER'S NAME]" };
const LABEL_EMPLOYER = "[REDACTED YOUR EMPLOYER]";
const LABEL_WATCH = "[REDACTED WATCH LIST ITEM]";

// detect() finds `kind` in `text`, and both redact() and generalize() give `want`.
function covers(text, kind, want) {
  const found = C.detect(text);
  assert.ok(
    found.some((r) => r.id === kind),
    `${JSON.stringify(text)}: ${kind} not found, got ${JSON.stringify(found.map((r) => [r.id, r.matches]))}`,
  );
  assert.equal(C.redact(text, found), want, `redact ${JSON.stringify(text)}`);
  assert.equal(C.generalize(text, found, "en"), want, `generalize ${JSON.stringify(text)}`);
}

// patterns.js keeps the vault's finds for the last text it read, so a timed call that repeats one text would time
// that cache: setting the vault again drops it.
function detectAfresh(entries, text) {
  C.setVault({ salt: SALT, entries });
  return C.detect(text);
}

test("a saved name written with combining accents (as macOS and some PDFs paste it) is found and covered whole", () => {
  withVault([saved("my_name", "José García")], () => {
    const nfd = "José García".normalize("NFD");
    covers(`hola, soy ${nfd}.`, "my_name", `hola, soy ${LABEL.my_name}.`);
    covers(`${nfd}`, "my_name", LABEL.my_name);
  });
});

test("a saved name in a script with vowel signs (Devanagari, Tamil, Thai) is found and covered with none of it left", () => {
  // Each one alone in the vault: one word, as vault.js counts it.
  for (const [name, text, want] of [
    ["प्रिया", "मेरा नाम प्रिया है", `मेरा नाम ${LABEL.my_name} है`],
    ["தமிழ்செல்வி", "நான் தமிழ்செல்வி", `நான் ${LABEL.my_name}`],
    ["สมศักดิ์", "ชื่อ สมศักดิ์ ครับ", `ชื่อ ${LABEL.my_name} ครับ`],
  ]) {
    withVault([saved("my_name", name)], () => covers(text, "my_name", want));
  }
});

test("a saved word glued together by punctuation (AT&T, H&M) is found when it's the only one saved", () => {
  withVault([saved("employer", "AT&T")], () => {
    covers("I work at AT&T now", "employer", `I work at ${LABEL_EMPLOYER} now`);
    covers("AT&T", "employer", LABEL_EMPLOYER);
  });
  withVault([saved("employer", "H&M")], () => covers("the H&M store", "employer", `the ${LABEL_EMPLOYER} store`));
  withVault([saved("employer", "Procter&Gamble Co")], () =>
    covers("at Procter&Gamble Co today", "employer", `at ${LABEL_EMPLOYER} today`),
  );
});

test("a word saved with its closing punctuation (Acme Corp., Yahoo!, C++) is still found", () => {
  withVault([saved("employer", "Acme Corp.")], () => {
    covers("I work at Acme Corp. in town", "employer", `I work at ${LABEL_EMPLOYER} in town`);
    covers("I work at Acme Corp.", "employer", `I work at ${LABEL_EMPLOYER}`);
  });
  withVault([saved("employer", "Yahoo!")], () =>
    covers("Yahoo! is where I work", "employer", `${LABEL_EMPLOYER} is where I work`),
  );
  withVault([saved("watch_list", "C++")], () =>
    covers("our C++ codebase", "watch_list", `our ${LABEL_WATCH} codebase`),
  );
});

test("a saved name right after a written \\n or \\t escape (a log line, a code string) is found and every copy covered", () => {
  const bs = "\\";
  withVault([saved("my_name", "Ann")], () => {
    covers(`Thanks,${bs}nAnn`, "my_name", `Thanks,${bs}n${LABEL.my_name}`);
    covers(`Ann wrote:${bs}nThanks,${bs}nAnn`, "my_name", `${LABEL.my_name} wrote:${bs}nThanks,${bs}n${LABEL.my_name}`);
    covers(`col1${bs}tAnn${bs}r${bs}n`, "my_name", `col1${bs}t${LABEL.my_name}${bs}r${bs}n`);
  });
  // A name that really starts with the letter after the backslash is still read as written.
  withVault([saved("my_name", "Nancy")], () => {
    covers(`C:${bs}Users${bs}nancy${bs}Documents`, "my_name", `C:${bs}Users${bs}${LABEL.my_name}${bs}Documents`);
  });
});

test("a saved name in Chinese, Japanese, Korean or Thai is found inside a sentence written without spaces", () => {
  for (const [name, text, want] of [
    ["王小明", "我叫王小明。", `我叫${LABEL.my_name}。`],
    ["王小明", "王小明，你好。我叫王小明", `${LABEL.my_name}，你好。我叫${LABEL.my_name}`],
    ["山田太郎", "私は山田太郎です", `私は${LABEL.my_name}です`],
    ["김민수", "저는 김민수입니다", `저는 ${LABEL.my_name}입니다`],
    ["김민수", "김민수 씨, 김민수는 학생이에요", `${LABEL.my_name} 씨, ${LABEL.my_name}는 학생이에요`],
    ["สมชาย", "ผมชื่อสมชายครับ", `ผมชื่อ${LABEL.my_name}ครับ`],
  ]) {
    withVault([saved("my_name", name)], () => covers(text, "my_name", want));
  }
  // A Latin name glued to other Latin letters is still a different word.
  withVault([saved("my_name", "Ann")], () => {
    const found = C.detect("Ann and Annabelle");
    assert.equal(C.redact("Ann and Annabelle", found), `${LABEL.my_name} and Annabelle`);
  });
});

test("a saved Latin name written straight into Chinese, Japanese or Thai text is found and covered", () => {
  withVault([saved("my_name", "Ann")], () => {
    covers("我叫Ann。", "my_name", `我叫${LABEL.my_name}。`);
    covers("Annさん、こんにちは", "my_name", `${LABEL.my_name}さん、こんにちは`);
    covers("ผมชื่อAnnครับ", "my_name", `ผมชื่อ${LABEL.my_name}ครับ`);
    covers("Ann and 社員Ann", "my_name", `${LABEL.my_name} and 社員${LABEL.my_name}`);
  });
  withVault([saved("my_name", "Ann Smith")], () => covers("私はAnn Smithです", "my_name", `私は${LABEL.my_name}です`));
});

test("a saved name joined by hyphens, underscores, dots or plus signs (a username, a link) is found and covered", () => {
  withVault([saved("my_name", "Ann Smith")], () => {
    covers("user ann_smith logged in", "my_name", `user ${LABEL.my_name} logged in`);
    covers("see linkedin.com/in/ann-smith-4b2a", "my_name", `see linkedin.com/in/${LABEL.my_name}-4b2a`);
    covers("search?q=Ann+Smith&hl=en", "my_name", `search?q=${LABEL.my_name}&hl=en`);
    covers("files/ann.smith/notes.txt", "my_name", `files/${LABEL.my_name}/notes.txt`);
  });
  withVault([saved("my_name", "Ann Marie Smith")], () =>
    covers("by Ann-Marie Smith", "my_name", `by ${LABEL.my_name}`),
  );
  // One saved word is still not a part of a hyphenated name.
  withVault([saved("my_name", "Ann")], () => {
    assert.ok(!C.detect("Ann-Marie said hi").some((r) => r.id === "my_name"));
  });
});

test("a saved name written with escapes (JSON \\u, a link's %, a written \\n) is found and covered", () => {
  const bs = "\\";
  withVault([saved("my_name", "José García")], () => {
    covers(`{"name":"Jos${bs}u00e9 Garc${bs}u00eda"}`, "my_name", `{"name":"${LABEL.my_name}"}`);
    covers("name=Jos%C3%A9%20Garc%C3%ADa&x=1", "my_name", `name=${LABEL.my_name}&x=1`);
  });
  withVault([saved("my_name", "王小明")], () =>
    covers(`{"n":"${bs}u738b${bs}u5c0f${bs}u660e"}`, "my_name", `{"n":"${LABEL.my_name}"}`),
  );
  withVault([saved("my_name", "Ann Smith")], () => {
    covers(`log: hi${bs}tAnn${bs}nSmith wrote`, "my_name", `log: hi${bs}t${LABEL.my_name} wrote`);
    covers("name=Ann%20Smith", "my_name", `name=${LABEL.my_name}`);
    // Written plainly too, every escaped copy still goes.
    covers(
      `Ann Smith: q=hello%20Ann%20Smith, "hi${bs}u0020Ann Smith"`,
      "my_name",
      `${LABEL.my_name}: q=hello%20${LABEL.my_name}, "hi${bs}u0020${LABEL.my_name}"`,
    );
  });
});

test("a company saved with its closing dot (Acme Corp., Smith Jr.) is found written without it", () => {
  withVault([saved("employer", "Acme Corp.")], () =>
    covers("I work at Acme Corp now", "employer", `I work at ${LABEL_EMPLOYER} now`),
  );
  withVault([saved("my_name", "John Smith Jr.")], () =>
    covers("from John Smith Jr today", "my_name", `from ${LABEL.my_name} today`),
  );
});

test("a handle saved with its @ is found", () => {
  withVault([saved("my_name", "@ann_w")], () => covers("ping @ann_w later", "my_name", `ping ${LABEL.my_name} later`));
});

test("a saved ID format is found beside an underscore (a file name, a branch)", () => {
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "@@-####" }] });
  try {
    covers("see report_AB-1234.pdf", "my_id", "see report_[REDACTED YOUR ACCOUNT/ID NUMBER].pdf");
    covers("branch fix/AB-1234_login", "my_id", "branch fix/[REDACTED YOUR ACCOUNT/ID NUMBER]_login");
    // Still not part of a longer ID.
    assert.ok(!C.detect("XAB-1234 and AB-12345").some((r) => r.id === "my_id"));
  } finally {
    C.setVault(null);
  }
});

test("a very large vault still loads, and one bad word count doesn't turn the others off", () => {
  const many = Array.from({ length: 200000 }, (_, i) => ({
    kind: "word",
    type: "watch_list",
    fp: (i.toString(16) + "0".repeat(16)).slice(0, 16),
    words: 2,
  }));
  withVault([...many, saved("my_name", "Ann Smith")], () => covers("hi Ann Smith", "my_name", `hi ${LABEL.my_name}`));
  withVault([{ ...saved("watch_list", "Falcon"), words: "many" }, saved("my_name", "Ann")], () =>
    covers("hi Ann", "my_name", `hi ${LABEL.my_name}`),
  );
});

test("a team's nearby word in Japanese counts with a particle right after it", () => {
  C.setVault({
    salt: SALT,
    kinds: [{ id: "team_case_code", name: "Case code", cover: "Case" }],
    entries: [{ kind: "shape", type: "team_case_code", shape: "@@-####", near: ["案件番号"] }],
  });
  try {
    const found = (text) => C.detect(text).find((r) => r.id === "team_case_code")?.matches || [];
    assert.deepEqual(found("案件番号はAB-1234です"), ["AB-1234"]);
    assert.deepEqual(found("案件番号 AB-1234"), ["AB-1234"]);
    assert.deepEqual(found("電話 AB-1234"), []);
  } finally {
    C.setVault(null);
  }
});

test("a saved name matches with or without the letters that carry their mark inside (Ł, Đ, Ø, ß, Æ)", () => {
  for (const [name, texts] of [
    ["Łukasz", ["Łukasz", "Lukasz", "LUKASZ"]],
    ["Lukasz", ["Łukasz"]],
    ["Đorđe", ["Đorđe", "Dorde"]],
    ["Søren", ["Søren", "Soren"]],
    ["Weiß", ["Weiß", "WEISS", "Weiss"]],
    ["Ærø", ["Ærø", "Aero"]],
  ]) {
    withVault([saved("my_name", name)], () => {
      for (const text of texts) covers(`hi ${text}!`, "my_name", `hi ${LABEL.my_name}!`);
    });
  }
  // A word saved before folding these letters still matches as it was typed.
  const legacy = { kind: "word", type: "my_name", fp: C.fingerprint(SALT, "watch_list_marks", "Łukasz"), words: 1 };
  withVault([legacy], () => covers("hi Łukasz!", "my_name", `hi ${LABEL.my_name}!`));
});

test("cleaning leaves every letter of the scripts written without spaces as it is, but their digits and fillers", () => {
  // detector.js normalize skips cleanText for a stretch of only these (CLEAN_ALREADY), which is right only while
  // cleanText leaves each of them alone.
  const closed =
    /^(?:(?!\p{Nd}|\u115f|\u1160|\u3164|\uffa0|\u17b4|\u17b5)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])+$/u;
  const changed = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (closed.test(ch) && C.cleanText(`"${ch}%`).clean !== `"${ch}%`) changed.push(cp.toString(16));
  }
  assert.deepEqual(changed, []);
  // And a saved name in those scripts is found the same either way.
  withVault([saved("my_name", "สมชาย")], () => covers("ผมชื่อสมชายครับ", "my_name", `ผมชื่อ${LABEL.my_name}ครับ`));
});

// ---------- Round 2 ----------

test("a Korean word saved before 0.9.67 (its accented form) is still found and covered", () => {
  // Hangul splits into jamo under NFD, which aren't marks, so the old form differs from the new one with no mark.
  withVault([savedBefore("my_name", "김민수", "watch_list_accented")], () => {
    covers("저는 김민수 입니다", "my_name", `저는 ${LABEL.my_name} 입니다`);
    covers("김민수", "my_name", LABEL.my_name);
  });
  // And one typed with its accent as a mark of its own, saved that way before 0.9.67.
  const nfd = "José".normalize("NFD");
  withVault([savedBefore("my_name", nfd, "watch_list_accented")], () =>
    covers(`soy ${nfd}.`, "my_name", `soy ${LABEL.my_name}.`),
  );
});

test("a saved word mixing scripts and digits with no space (101동1203호, 3年B組) is found with only one-word entries", () => {
  for (const [phrase, text, want] of [
    ["101동1203호", "주소는 101동1203호 입니다", `주소는 ${LABEL_WATCH} 입니다`],
    ["港区1丁目2番3号", "住所 港区1丁目2番3号 です", `住所 ${LABEL_WATCH} です`],
    ["3年B組", "私は 3年B組 です", `私は ${LABEL_WATCH} です`],
    ["Ann社長", "to Ann社長, hi", `to ${LABEL_WATCH}, hi`],
  ]) {
    withVault([saved("watch_list", phrase)], () => covers(text, "watch_list", want));
    // The same with a two-word entry beside it.
    withVault([saved("watch_list", phrase), saved("employer", "Acme Corp")], () => covers(text, "watch_list", want));
  }
  withVault([saved("watch_list", "Ann 3年B組")], () => covers("Ann 3年B組 です", "watch_list", `${LABEL_WATCH} です`));
});

test("a word saved with closing punctuation is found when the text has more, less or other punctuation", () => {
  withVault([saved("employer", "Yahoo!")], () => {
    covers("I love Yahoo!! a lot", "employer", `I love ${LABEL_EMPLOYER}! a lot`);
    covers("Yahoo!?", "employer", `${LABEL_EMPLOYER}?`);
  });
  withVault([saved("employer", "Acme Corp.")], () => {
    covers("I work at Acme Corp!", "employer", `I work at ${LABEL_EMPLOYER}!`);
    covers("Acme Corp..", "employer", `${LABEL_EMPLOYER}.`);
    covers("Acme Corp?", "employer", `${LABEL_EMPLOYER}?`);
  });
  withVault([saved("watch_list", "C++")], () => covers("C+++", "watch_list", `${LABEL_WATCH}+`));
  withVault([saved("my_name", "John Smith Jr.")], () => covers("John Smith Jr! ok", "my_name", `${LABEL.my_name}! ok`));
  // With Japanese or Chinese written straight after the punctuation.
  withVault([saved("employer", "Yahoo!")], () =>
    covers("私はYahoo!で働いています", "employer", `私は${LABEL_EMPLOYER}で働いています`),
  );
  withVault([saved("watch_list", "C++")], () => covers("C++で書いた", "watch_list", `${LABEL_WATCH}で書いた`));
  withVault([saved("employer", "Acme Corp.")], () => covers("Acme Corp.の社員", "employer", `${LABEL_EMPLOYER}の社員`));
});

test("a saved word in a script without spaces is found inside a sentence whatever its length", () => {
  for (const [type, name, text, want] of [
    ["employer", "株式会社日立製作所", "私は株式会社日立製作所で働いています", `私は${LABEL_EMPLOYER}で働いています`],
    ["employer", "三菱UFJ銀行", "私は三菱UFJ銀行で働いています", `私は${LABEL_EMPLOYER}で働いています`],
    ["watch_list", "3年B組", "私は3年B組です", `私は${LABEL_WATCH}です`],
    ["watch_list", "101동1203호", "주소는101동1203호입니다", `주소는${LABEL_WATCH}입니다`],
    [
      "employer",
      "独立行政法人情報処理推進機構本部",
      "私は独立行政法人情報処理推進機構本部の職員です",
      `私は${LABEL_EMPLOYER}の職員です`,
    ],
  ]) {
    withVault([saved(type, name)], () => covers(text, type, want));
  }
});

test("a saved name with a space between its parts is found with an honorific or particle glued on", () => {
  withVault([saved("my_name", "山田 太郎")], () => {
    covers("山田 太郎さん、こんにちは", "my_name", `${LABEL.my_name}さん、こんにちは`);
    covers("私は山田 太郎です", "my_name", `私は${LABEL.my_name}です`);
    covers("山田 太郎", "my_name", LABEL.my_name);
  });
  withVault([saved("my_name", "김 민수")], () =>
    covers("김 민수님 안녕하세요", "my_name", `${LABEL.my_name}님 안녕하세요`),
  );
});

test("a vault word saved before letter counts were kept is found as a whole word, as before", () => {
  withVault([savedBefore("my_name", "王小明")], () => {
    covers("我叫 王小明 。", "my_name", `我叫 ${LABEL.my_name} 。`);
    covers("王小明", "my_name", LABEL.my_name);
  });
});

test("wordEntry keeps a letter count only for a word written in a script without spaces, and storage keeps it", () => {
  assert.equal(saved("my_name", "Ann Smith").closed, undefined);
  assert.equal(saved("my_name", "王小明").closed, 3);
  assert.equal(saved("my_name", "สมศักดิ์").closed, 5);
  assert.equal(saved("my_name", "王").closed, undefined); // one letter: only ever a word of its own
  assert.equal(saved("my_name", "3年B組").closed, 4); // 3, 年, B, 組
  assert.equal(saved("employer", "三菱UFJ銀行").closed, 5);
  assert.equal(saved("employer", "AT&T東京").closed, undefined); // punctuation: found as words of its own
  assert.equal(saved("my_name", "山田 太郎").closed, 4); // spaces between its words allowed: 山, 田, 太, 郎
  assert.equal(saved("my_name", "Ann Smith 3").closed, undefined); // no letter of those scripts
  assert.equal(saved("my_name", "Ann").closed, undefined);
  assert.equal(saved("my_name", "王小明").fp, C.fingerprint(SALT, "watch_list", "王小明"));
  assert.equal(saved("my_name", "Ann Lee Smith").words, 3);
  // It's a count and a few bits of a head, never the word.
  assert.deepEqual(Object.keys(saved("my_name", "王小明")).sort(), ["closed", "fp", "head", "kind", "type", "words"]);
  assert.equal(saved("my_name", "Ann").head, undefined);
  const kept = C.cleanVaultEntry(saved("my_name", "王小明"));
  assert.equal(kept.closed, 3);
  assert.equal(kept.head, saved("my_name", "王小明").head);
  assert.ok(Number.isInteger(kept.head) && kept.head >= 0 && kept.head < 4096);
  for (const bad of [1, 0, -2, 2.5, "3", 1e9, null]) {
    assert.equal(C.cleanVaultEntry({ ...saved("my_name", "王小明"), closed: bad }).closed, undefined, String(bad));
  }
  // One without the other is kept as neither.
  for (const bad of [-1, 4096, 2.5, "7", null, undefined]) {
    const e = C.cleanVaultEntry({ ...saved("my_name", "王小明"), head: bad });
    assert.equal(e.closed, undefined, String(bad));
    assert.equal(e.head, undefined, String(bad));
  }
  assert.equal(C.cleanVaultEntry({ kind: "value", type: "email", fp: "0".repeat(16), closed: 3 }).closed, undefined);
});

test("a vault with no word in a script without spaces doesn't look up every stretch of such text", () => {
  const ja = "今日はとても良い天気ですね。".repeat(800);
  const zh = "我们今天去公园散步然后吃饭".repeat(800);
  const lookups = (entries, text) => {
    const real = C.fingerprint;
    let n = 0;
    C.fingerprint = (...a) => {
      n++;
      return real(...a);
    };
    try {
      withVault(entries, () => C.detect(text));
    } finally {
      C.fingerprint = real;
    }
    return n;
  };
  for (const text of [ja, zh]) {
    // About one lookup per word of the text, not several per letter.
    assert.ok(lookups([saved("employer", "Acme")], text) < text.length / 4, "English-only vault");
    assert.ok(lookups([saved("employer", "Acme Corp"), saved("my_name", "Ann")], text) < text.length / 4);
    // With a Chinese name of 3 letters saved, about one lookup per letter.
    assert.ok(lookups([saved("my_name", "王小明")], text) < text.length * 2.5, "one closed word");
  }
});

test("Cover it hides a copy found after a percent-escaped space or punctuation mark, and after a stray mark", () => {
  withVault([saved("my_name", "Ann")], () => {
    for (const [esc, label] of [
      ["%C2%A0", "no-break space"],
      ["%E2%80%8B", "zero-width space"],
      ["%E3%80%80", "ideographic space"],
      ["%E3%80%82", "ideographic full stop"],
      ["%E2%80%94", "em dash"],
    ]) {
      covers(`Ann wrote: q=hi${esc}Ann`, "my_name", `${LABEL.my_name} wrote: q=hi${esc}${LABEL.my_name}`);
      void label;
    }
    // A letter written as a percent escape before it still makes a longer word.
    const found = C.detect("Ann and Jos%C3%A9Ann");
    assert.equal(C.redact("Ann and Jos%C3%A9Ann", found), `${LABEL.my_name} and Jos%C3%A9Ann`);
    // A mark with no letter before it (after a space) isn't part of a word.
    covers(" ́Ann and Ann", "my_name", ` ́${LABEL.my_name} and ${LABEL.my_name}`);
  });
});

test("a saved ID format is found with a hyphen and a word after it (a branch name), but not inside a longer ID", () => {
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "@@-####" }] });
  try {
    const ID = "[REDACTED YOUR ACCOUNT/ID NUMBER]";
    covers("branch feature/AB-1234-fix-login", "my_id", `branch feature/${ID}-fix-login`);
    covers("git checkout AB-1234-login", "my_id", `git checkout ${ID}-login`);
    covers("filed 2024-AB-1234 today", "my_id", `filed 2024-${ID} today`);
    // A hyphen and more of the same kind of character is a longer ID.
    for (const text of ["AB-1234-5678", "XY-AB-1234", "ref-AB-1234", "AB-1234-56"]) {
      assert.ok(!C.detect(text).some((r) => r.id === "my_id"), text);
    }
  } finally {
    C.setVault(null);
  }
  // A format ending in a letter: a hyphen and digits after it is a word of its own, more letters a longer ID.
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "####-@@" }] });
  try {
    covers("see 1234-AB-2 now", "my_id", "see [REDACTED YOUR ACCOUNT/ID NUMBER]-2 now");
    assert.ok(!C.detect("see 1234-AB-CD now").some((r) => r.id === "my_id"));
  } finally {
    C.setVault(null);
  }
});

test("a saved Japanese name is found in half-width katakana (a bank transfer's account name), and the other way round", () => {
  withVault([saved("my_name", "ヤマダ タロウ")], () => {
    covers("振込 ﾔﾏﾀﾞ ﾀﾛｳ 様", "my_name", `振込 ${LABEL.my_name} 様`);
    covers("ﾔﾏﾀﾞ ﾀﾛｳ", "my_name", LABEL.my_name);
  });
  withVault([saved("my_name", "ﾔﾏﾀﾞ")], () => {
    covers("ヤマダさんへ", "my_name", `${LABEL.my_name}さんへ`);
    covers("ﾔﾏﾀﾞｻﾏ", "my_name", `${LABEL.my_name}ｻﾏ`);
  });
  withVault([saved("employer", "ヤマダ")], () =>
    covers("ﾔﾏﾀﾞｼｮｳｼﾞ ﾔﾏﾀﾞ", "employer", `${LABEL_EMPLOYER}ｼｮｳｼﾞ ${LABEL_EMPLOYER}`),
  );
});

test("a saved Arabic or Persian name is found with the other form of yeh, kaf or teh marbuta, or stretched by tatweel", () => {
  for (const [name, texts] of [
    ["محمد", ["محـــمد", "مـحـمـد"]],
    ["علی", ["علي"]],
    ["علي", ["علی"]],
    ["کریم", ["كريم"]],
    ["فاطمة", ["فاطمه"]],
  ]) {
    withVault([saved("my_name", name)], () => {
      for (const text of texts) covers(`اسمي ${text} هنا`, "my_name", `اسمي ${LABEL.my_name} هنا`);
    });
  }
  // Alef maksura stays apart: "على" is also the everyday word for "on".
  withVault([saved("my_name", "علي")], () =>
    assert.ok(!C.detect("الكتاب على الطاولة").some((r) => r.id === "my_name")),
  );
  // A word saved before these letters were folded still matches as it was typed.
  withVault([savedBefore("my_name", "علی", "watch_list_marks")], () =>
    covers("اسمي علی هنا", "my_name", `اسمي ${LABEL.my_name} هنا`),
  );
});

test("a saved word in HTML or XML source (entities, tags between its words) is found and covered", () => {
  withVault([saved("my_name", "Ann Smith"), saved("family_name", "O'Brien"), saved("employer", "AT&T")], () => {
    covers("<p>Hi Ann&nbsp;Smith</p>", "my_name", `<p>Hi ${LABEL.my_name}</p>`);
    covers("Hi <b>Ann</b> Smith", "my_name", `Hi <b>${LABEL.my_name}`);
    covers("<td>Ann</td><td>Smith</td>", "my_name", `<td>${LABEL.my_name}</td>`);
    covers("<name>Ann Smith</name>", "my_name", `<name>${LABEL.my_name}</name>`);
    covers("Dear Ann&#160;Smith,", "my_name", `Dear ${LABEL.my_name},`);
    covers("cousin O&#39;Brien", "family_name", `cousin ${LABEL["family_name"]}`);
    covers("cousin O&#x27;Brien", "family_name", `cousin ${LABEL["family_name"]}`);
    covers("cousin O&rsquo;Brien", "family_name", `cousin ${LABEL["family_name"]}`);
    covers("works at AT&amp;T now", "employer", `works at ${LABEL_EMPLOYER} now`);
  });
  withVault([saved("my_name", "José García")], () => {
    covers("<p>Jos&eacute; Garc&iacute;a</p>", "my_name", `<p>${LABEL.my_name}</p>`);
    covers("Jos&#233; Garc&#xED;a", "my_name", LABEL.my_name);
  });
});

test("a saved word inside a code name, a domain or a username (INITECH_API, initech.com, smith1990) is found and covered", () => {
  withVault([saved("employer", "Initech")], () => {
    covers("export INITECH_API_KEY=", "employer", `export ${LABEL_EMPLOYER}_API_KEY=`);
    covers("apply at https://initech.com/careers", "employer", `apply at https://${LABEL_EMPLOYER}.com/careers`);
    covers("cd build.initech.v2/src", "employer", `cd build.${LABEL_EMPLOYER}.v2/src`);
    covers("bucket initech2024", "employer", `bucket ${LABEL_EMPLOYER}2024`);
    // Every copy goes, also one beside a digit where another stands alone.
    covers("Initech and Initech2", "employer", `${LABEL_EMPLOYER} and ${LABEL_EMPLOYER}2`);
  });
  withVault([saved("family_name", "Smith")], () => {
    covers("login smith1990 or j.smith", "family_name", `login ${LABEL.family_name}1990 or j.${LABEL.family_name}`);
    // A hyphen or an apostrophe still makes one name of the parts ("Smith-Jones", "O'Smith"), as before.
    assert.ok(!C.detect("the Smith-Jones family").some((r) => r.id === "family_name"));
  });
  // A whole saved phrase written as one name in code (AnnSmith, annSmith, ANN_SMITH1990).
  withVault([saved("my_name", "Ann Smith")], () => {
    covers("user AnnSmith logged in", "my_name", `user ${LABEL.my_name} logged in`);
    covers("const annSmith = 1", "my_name", `const ${LABEL.my_name} = 1`);
    covers("id annSmith1990 here", "my_name", `id ${LABEL.my_name}1990 here`);
    covers("mail ann.smith1990@x", "my_name", `mail ${LABEL.my_name}1990@x`);
  });
  // One saved word is never a capital-led piece of a longer name ("McDonald" for "Donald").
  withVault([saved("my_name", "Donald")], () => {
    assert.ok(!C.detect("lunch at McDonald today").some((r) => r.id === "my_name"));
  });
});

test("a hyphenated saved name (Jean-Luc, Smith-Jones) is found written with a space instead", () => {
  withVault([saved("my_name", "Jean-Luc")], () => {
    covers("bonjour Jean Luc !", "my_name", `bonjour ${LABEL.my_name} !`);
    covers("bonjour Jean-Luc !", "my_name", `bonjour ${LABEL.my_name} !`);
    covers("bonjour jean_luc !", "my_name", `bonjour ${LABEL.my_name} !`);
  });
  withVault([saved("my_name", "Mary-Kate Smith-Jones")], () => {
    covers("from Mary Kate Smith Jones.", "my_name", `from ${LABEL.my_name}.`);
    covers("from Mary-Kate Smith Jones.", "my_name", `from ${LABEL.my_name}.`);
  });
  withVault([saved("watch_list", "EMP-12345")], () =>
    covers("ticket EMP 12345 today", "watch_list", `ticket ${LABEL_WATCH} today`),
  );
  // A word saved before this still matches as it was typed, hyphen and all.
  const before = { kind: "word", type: "my_name", fp: C.sha256(`${SALT}watch_list:jean-luc`).slice(0, 16), words: 1 };
  withVault([before], () => covers("bonjour Jean-Luc !", "my_name", `bonjour ${LABEL.my_name} !`));
  // One saved part is still not the hyphenated name.
  withVault([saved("my_name", "Jean")], () => assert.ok(!C.detect("bonjour Jean-Luc").some((r) => r.id === "my_name")));
});

test("a saved ID format is found in a link or escaped text (%22AB-1234%22, AB%201234, AB+1234, \\tAB-1234)", () => {
  const ID = "[REDACTED YOUR ACCOUNT/ID NUMBER]";
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "@@-####" }] });
  try {
    covers("q=%22AB-1234%22&x=1", "my_id", `q=%22${ID}%22&x=1`);
    covers("ref%3AAB-1234", "my_id", `ref%3A${ID}`);
    covers("x=AB%2D1234&y", "my_id", `x=${ID}&y`);
    covers('{"t":"a\\tAB-1234"}', "my_id", `{"t":"a\\t${ID}"}`);
    // Still not part of a longer ID once read.
    for (const text of ["q=%22XAB-1234%22", "q=AB%2D12345", "x%2DAB-1234"]) {
      assert.ok(!C.detect(text).some((r) => r.id === "my_id"), text);
    }
  } finally {
    C.setVault(null);
  }
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "@@ ####" }] });
  try {
    covers("search?q=AB+1234&page=2", "my_id", `search?q=${ID}&page=2`);
    covers("search?q=AB%201234&page=2", "my_id", `search?q=${ID}&page=2`);
    covers("<td>AB&nbsp;1234</td>", "my_id", `<td>${ID}</td>`);
    covers("AB\u00a01234", "my_id", ID);
  } finally {
    C.setVault(null);
  }
  C.setVault({ salt: SALT, entries: [{ kind: "shape", type: "my_id", shape: "### ### ###" }] });
  try {
    covers("n=123+456+789&x", "my_id", `n=${ID}&x`);
  } finally {
    C.setVault(null);
  }
});

test("a saved name in Chinese, Japanese or Korean is found with or without a space or a middle dot between its parts", () => {
  for (const [name, text, want] of [
    ["山田 太郎", "私は山田太郎です", `私は${LABEL.my_name}です`],
    ["山田 太郎", "山田太郎", LABEL.my_name],
    ["山田太郎", "私は山田 太郎です", `私は${LABEL.my_name}です`],
    ["山田太郎", "山田　太郎", LABEL.my_name],
    ["ジョン・スミス", "私はジョン・スミスです", `私は${LABEL.my_name}です`],
    ["ジョン・スミス", "ジョン スミス", LABEL.my_name],
    ["ジョン・スミス", "ジョンスミスさん", `${LABEL.my_name}さん`],
    ["ジョン スミス", "宛先：ジョン・スミス様", `宛先：${LABEL.my_name}様`],
    ["ジョン スミス", "ｼﾞｮﾝ･ｽﾐｽ", LABEL.my_name],
    ["김 민수", "저는 김민수입니다", `저는 ${LABEL.my_name}입니다`],
    ["김민수", "김 민수 씨", `${LABEL.my_name} 씨`],
  ]) {
    withVault([saved("my_name", name)], () => covers(text, "my_name", want));
  }
  // A name saved before this, with its space or dot, is still found as it was.
  const before = (phrase, closed) => ({
    kind: "word",
    type: "my_name",
    fp: C.sha256(`${SALT}watch_list:${phrase}`).slice(0, 16),
    words: phrase.split(" ").length,
    ...(closed ? { closed, head: saved("my_name", phrase).head } : {}),
  });
  withVault([before("山田 太郎", 4)], () => {
    covers("私は山田 太郎です", "my_name", `私は${LABEL.my_name}です`);
    covers("山田 太郎", "my_name", LABEL.my_name);
  });
  withVault([before("ジョン・スミス")], () => covers("ジョン・スミス", "my_name", LABEL.my_name));
  // Its parts apart are still not the name.
  withVault([saved("my_name", "山田 太郎")], () => {
    assert.ok(!C.detect("山田さんと太郎").some((r) => r.id === "my_name"));
  });
});

test("a saved name with an apostrophe (O'Brien) is found typed with another mark or none (O`Brien, OBrien)", () => {
  withVault([saved("my_name", "O'Brien")], () => {
    for (const text of ["O'Brien", "O’Brien", "O`Brien", "O´Brien", "OBrien", "obrien"]) {
      covers(`from ${text} today`, "my_name", `from ${LABEL.my_name} today`);
    }
    covers("see github.com/obrien/notes", "my_name", `see github.com/${LABEL.my_name}/notes`);
  });
  // Saved without its apostrophe, it's found as saved. Typed with one after its first letter it reads like an
  // elision, as "L'Ami" isn't a saved "Lami", so it's the name saved with its apostrophe that finds both.
  withVault([saved("my_name", "OBrien")], () => covers("Dear obrien,", "my_name", `Dear ${LABEL.my_name},`));
  // A name saved before this still matches as it was typed.
  const before = { kind: "word", type: "my_name", fp: C.sha256(`${SALT}watch_list:o'brien`).slice(0, 16), words: 1 };
  withVault([before], () => covers("Dear O'Brien,", "my_name", `Dear ${LABEL.my_name},`));
  withVault([saved("employer", "L'Oréal")], () => covers("at Loreal Paris", "employer", `at ${LABEL_EMPLOYER} Paris`));
  // A short word after it is a contraction, not a name: "She'll" is not a saved "Shell".
  withVault([saved("employer", "Shell"), saved("watch_list", "Cant")], () => {
    const found = C.detect("She'll say we can't, and she'd go");
    assert.ok(!found.some((r) => r.id === "employer" || r.id === "watch_list"), JSON.stringify(found));
  });
  // A part of it on its own is still not the name.
  withVault([saved("my_name", "Brien")], () => assert.ok(!C.detect("Dear O'Brien").some((r) => r.id === "my_name")));
});

test("a saved phrase is found with marks between its words (Markdown, a CSV row, a path)", () => {
  withVault([saved("my_name", "Ann Smith")], () => {
    covers("hi **Ann** Smith", "my_name", `hi **${LABEL.my_name}`);
    covers("hi _Ann_ _Smith_", "my_name", `hi _${LABEL.my_name}_`);
    covers("id,first,last\n7,Ann,Smith\n", "my_name", `id,first,last\n7,${LABEL.my_name}\n`);
    covers('"Ann","Smith"', "my_name", `"${LABEL.my_name}"`);
    covers("C:/people/Ann/Smith/cv.pdf", "my_name", `C:/people/${LABEL.my_name}/cv.pdf`);
    covers("Ann | Smith", "my_name", LABEL.my_name);
  });
  withVault([saved("watch_list", "Project Falcon")], () =>
    covers("see `Project` *Falcon* now", "watch_list", `see \`${LABEL_WATCH}* now`),
  );
  // Not across a sentence's end.
  withVault([saved("my_name", "Ann Smith")], () => {
    assert.ok(!C.detect("I met Ann. Smith called later").some((r) => r.id === "my_name"));
  });
});

test("a saved name is found in text whose accents were read with the wrong encoding (JosÃ© for José)", () => {
  // Each accented letter as UTF-8 bytes read one by one as Windows-1252 letters, as a CSV opened in a spreadsheet shows.
  const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
  const misread = (s) =>
    [...Buffer.from(s, "utf8")]
      .map((b) => (b < 0x80 || b >= 0xa0 ? String.fromCharCode(b) : CP1252[b - 0x80]))
      .join("");
  for (const [name, text] of [
    ["José García", "José García,Madrid"],
    ["Zoë", "from Zoë today"],
    ["Łukasz Wiśniewski", "Łukasz Wiśniewski;Kraków"],
    ["François", "François à Paris"],
  ]) {
    const shown = misread(text);
    const want = misread(text.replace(name, "\0")).replace("\0", LABEL.my_name);
    withVault([saved("my_name", name)], () => covers(shown, "my_name", want));
  }
  // Text that only looks like it is still read as written.
  withVault([saved("my_name", "Ann")], () =>
    covers("Ã©Ann and ©Ann", "my_name", `Ã©${LABEL.my_name} and ©${LABEL.my_name}`),
  );
});

// UTF-8 bytes read one by one as Windows-1252 letters, as a CSV opened in a spreadsheet shows them.
const CP1252_SHOWN = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const misread = (s) =>
  [...Buffer.from(s, "utf8")]
    .map((b) => (b < 0x80 || b >= 0xa0 ? String.fromCharCode(b) : CP1252_SHOWN[b - 0x80]))
    .join("");

test("300 KB of stray percent escapes with a saved word is scanned whole: the email at the end is found", () => {
  const email = ["jane.doe", "example.com"].join("@");
  const entries = [saved("my_name", "Ann Smith")];
  const text = `${"%C3".repeat(100_000)} ${email}`;
  withVault(entries, () => {
    C.detect.forget();
    const found = C.detect(text);
    assert.ok(!found.truncated, "scan cut short");
    assert.ok(found.some((r) => r.id === "email"));
  });
});

test("stray percent escapes are read without an error thrown for each, and add no second look at the text", () => {
  const entries = [saved("my_name", "Ann Smith")];
  const count = (text) => {
    const realFp = C.fingerprint;
    const realDecode = globalThis.decodeURIComponent;
    const n = { lookups: 0, decodes: 0 };
    C.fingerprint = (...a) => {
      n.lookups++;
      return realFp(...a);
    };
    globalThis.decodeURIComponent = (...a) => {
      n.decodes++;
      return realDecode(...a);
    };
    try {
      detectAfresh(entries, text);
    } finally {
      C.fingerprint = realFp;
      globalThis.decodeURIComponent = realDecode;
      C.setVault(null);
    }
    return n;
  };
  for (const unit of ["%C3", "%E2%80", "%F0%9F%98", "%C3%C3%A9a "]) {
    const n = count(unit.repeat(3000));
    assert.ok(n.decodes < 50, `${unit}: ${n.decodes} decodes`);
  }
  // A paste of escapes that read as nothing is looked up no more than the same paste with "$" for "%".
  const percent = count("%C3".repeat(3000)).lookups;
  const dollar = count("$C3".repeat(3000)).lookups;
  assert.ok(percent <= dollar * 1.1, `${percent} lookups vs ${dollar}`);
  // A paste with one escape that reads looks up only the phrases beside it once more.
  const one = count(`${"%C3".repeat(3000)}%C3%A9`).lookups;
  assert.ok(one <= dollar * 1.1 + 50, `${one} lookups vs ${dollar}`);
  // And a repeated paste looks each different phrase up once, not once per copy.
  assert.ok(count("ジ・".repeat(5000)).lookups < 500);
});

test("a saved name is found in the wrong encoding where cleaning would fold the bytes (ó, ú, Ñ, ń, ř, ễ, Cyrillic, CJK)", () => {
  for (const [name, text] of [
    ["López", "Ana López;Madrid"],
    ["Gómez", "from Gómez today"],
    ["Ramón", "Ramón,Sevilla"],
    ["Kraków", "Kraków office"],
    ["Núñez", "Sr. Núñez dijo"],
    ["Ñandú", "Ñandú,1"],
    ["Gdańsk", "Gdańsk port"],
    ["Śląsk", "Śląsk region"],
    ["Dvořák", "Dvořák wrote"],
    ["Þór", "to Þór now"],
    ["Nguyễn", "Nguyễn Văn"],
    ["Иван", "Иван Петров"],
    ["山田", "私は山田です"],
    ["太郎", "太郎さん"],
  ]) {
    const shown = misread(text);
    const want = misread(text.replace(name, "\0")).replace("\0", LABEL.my_name);
    withVault([saved("my_name", name)], () => covers(shown, "my_name", want));
  }
  // Inside a longer paste with other cleaning around it, and in a format.
  withVault([saved("my_name", "López")], () => {
    const shown = `“quoted” — ${misread("López")}… ok`;
    covers(shown, "my_name", `“quoted” — ${LABEL.my_name}… ok`);
  });
});

test("a saved Korean word is not found across a space from the middle of a word", () => {
  for (const [name, text] of [
    ["이준", "이 준비가 됐다"],
    ["민수", "국민 수준이 높다"],
    ["김민수", "김민 수준이 높다"],
    ["이준", "이 준비"],
  ]) {
    withVault([saved("my_name", name)], () => {
      const found = C.detect(text);
      assert.ok(!found.some((r) => r.id === "my_name"), `${name} in ${text}: ${JSON.stringify(found)}`);
    });
  }
  // From a word's start to a word's end, or to the particles after a name, it still is.
  for (const [name, text, want] of [
    ["김민수", "김 민수가 왔다", `${LABEL.my_name}가 왔다`],
    ["김민수", "김 민수 씨", `${LABEL.my_name} 씨`],
    ["김민수", "김 민수님께서", `${LABEL.my_name}님께서`],
    ["이준", "이 준이 왔다", `${LABEL.my_name}이 왔다`],
    ["이준", "이 준 씨", `${LABEL.my_name} 씨`],
    ["김 민수", "저는 김민수입니다", `저는 ${LABEL.my_name}입니다`],
  ]) {
    withVault([saved("my_name", name)], () => covers(text, "my_name", want));
  }
});

test("a saved Latin name written straight after Chinese or Japanese is covered ('社員Ann')", () => {
  withVault([saved("my_name", "Ann")], () => {
    covers("Ann wrote to Annéa and 社員Ann", "my_name", `${LABEL.my_name} wrote to Annéa and 社員${LABEL.my_name}`);
  });
});

// Saved words in a script without spaces of every length from 2 to 64 letters (an employer, an address, a long
// title), each looked for inside such text only in a stretch that long.
const LONG_CJK =
  "株式会社山田製作所東京都千代田区丸の内一丁目二番三号山田ビルヂング四階営業本部第一課長補佐代理山田太郎様宛御中拝啓時下益々御清栄";
const everyLength = () => Array.from({ length: 63 }, (_, i) => saved("employer", LONG_CJK.slice(0, i + 2)));

// The fingerprints detect() works out for `text` with `entries` saved: the work of looking it up in the vault.
function fingerprintsFor(entries, text) {
  const real = C.fingerprint;
  let n = 0;
  C.fingerprint = (...a) => {
    n++;
    return real(...a);
  };
  try {
    detectAfresh(entries, text);
  } finally {
    C.fingerprint = real;
    C.setVault(null);
  }
  return n;
}

// Chinese with a space now and then, from a fixed seed: no stretch of it repeats, so no lookup is answered twice.
function randomChinese(length, seed = 7) {
  let s = "";
  let x = seed;
  const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
  while (s.length < length) {
    s += String.fromCharCode(0x4e00 + Math.floor(next() * 3000));
    if (next() < 0.1) s += " ";
  }
  return s;
}

test("300 KB with 63 saved Chinese or Japanese words of every length is scanned whole, about as fast as with none", () => {
  assert.equal(LONG_CJK.length, 64);
  const entries = everyLength();
  assert.equal(new Set(entries.map((e) => e.closed)).size, 63);
  // The same words saved before a count of letters was kept: found only as whole words, with no run looked up.
  const wholeOnly = entries.map((e) => {
    const before = { ...e };
    delete before.closed;
    delete before.head;
    return before;
  });
  const email = ["jane.doe", "example.com"].join("@");
  const bs = "\\";
  // Best of two runs each, measured again before calling it slow (a busy machine).
  const time = (list, text) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      C.setVault({ salt: SALT, entries: list });
      C.detect.forget();
      const t = performance.now();
      C.detect(text);
      best = Math.min(best, performance.now() - t);
    }
    C.setVault(null);
    return best;
  };
  const slower = (unit, text, than, limit) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = time(than, text);
      const all = time(entries, text);
      if (all <= limit * Math.max(base, 150)) return false;
      console.info(
        `${unit}: ${Math.round(all)} ms with the counts, ${Math.round(base)} ms ${than.length ? "without" : "with no vault"}`,
      );
    }
    return true;
  };
  // "株式" and "株式会社" start every one of the saved words, so each copy of them starts a run of every count.
  for (const unit of ["3年B組", `${bs}u5c71`, "山", "ジ・", "株式", "株式会社"]) {
    const text = `${unit.repeat(Math.ceil(300_000 / unit.length))} contact ${email}`;
    const found = detectAfresh(entries, text);
    C.setVault(null);
    assert.ok(!found.truncated, `${unit}: scan cut short`);
    assert.ok(
      found.some((r) => r.id === "email"),
      `${unit}: email missed`,
    );
    // The whole scan stays within about 3 times the time with no vault. Where looking up whole words alone already
    // takes longer than that ("ジ・", as it did before runs were looked up), looking up runs adds little to it.
    if (["3年B組", `${bs}u5c71`].includes(unit)) {
      assert.ok(!slower(unit, text, [], 3), `${unit}: much slower than with no vault`);
    } else {
      assert.ok(!slower(unit, text, wholeOnly, 2), `${unit}: slower with the counts`);
    }
  }
});

test("a saved word adds little to the scan of a long paste that repeats a few characters", () => {
  const entries = [saved("my_name", "山田太郎")];
  // Best of two runs each, measured again before calling it slow (a busy machine).
  const time = (list, text) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      C.setVault(list.length ? { salt: SALT, entries: list } : null);
      C.detect.forget();
      const t = performance.now();
      C.detect(text);
      best = Math.min(best, performance.now() - t);
    }
    C.setVault(null);
    return best;
  };
  for (const unit of ["3年B組", "株式会社", "-=", "Ann Lee, "]) {
    const text = unit.repeat(Math.ceil(300_000 / unit.length));
    let slow = true;
    for (let attempt = 0; attempt < 3 && slow; attempt++) {
      const base = time([], text);
      const all = time(entries, text);
      slow = all > 1.5 * Math.max(base, 150);
      if (slow) console.info(`${unit}: ${Math.round(all)} ms with the word, ${Math.round(base)} ms with no vault`);
    }
    assert.ok(!slow, `${unit}: much slower with one saved word`);
  }
});

// A paste that almost repeats ("3年B組" with every 300th copy "3年C組") has nothing long enough to cut out, so the
// vault reads all of it.
const almostRepeating = (size, every) => {
  let out = "";
  for (let i = 0; out.length < size; i++) out += i % every === every - 1 ? "3年C組" : "3年B組";
  return out.slice(0, size);
};

test("a long paste with no space in it is looked up in its words and runs, never whole", () => {
  const text = `${almostRepeating(30_000, 300)} 3年B組の山田太郎です`;
  let longest = 0;
  const fingerprint = C.fingerprint;
  C.fingerprint = (salt, form, span) => {
    if (form.startsWith("watch_list")) {
      longest = Math.max(longest, span.length);
    }
    return fingerprint(salt, form, span);
  };
  let found;
  try {
    found = detectAfresh([saved("my_name", "山田太郎")], text);
  } finally {
    C.fingerprint = fingerprint;
    C.setVault(null);
  }
  assert.ok(longest < 1000, `${longest} characters looked up as one word`);
  assert.ok(found.some((r) => r.id === "my_name" && r.matches.includes("山田太郎")));
});

test("a saved word adds little to the scan of a long paste that almost repeats, in a sandbox as Guard runs it", () => {
  // Guard and the VS Code plugin run the engine in a vm context, where a hot loop costs more than it does here.
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const box = vm.createContext({ console: { info() {}, log() {}, warn() {}, error() {} } });
  for (const f of ["patterns.js", "detector.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension", f), "utf8"), box);
  }
  const E = vm.runInContext("globalThis.Clotr", box);
  // Best of two runs each, measured again before calling it slow (a busy machine).
  const time = (entries, text) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      E.setVault(entries.length ? { salt: SALT, entries } : null);
      E.detect.forget();
      const t = performance.now();
      E.detect(text);
      best = Math.min(best, performance.now() - t);
    }
    E.setVault(null);
    return best;
  };
  for (const [every, phrase] of [
    [300, "山田太郎"],
    [100, "山田太郎"],
    [300, "Ann Smith"],
  ]) {
    const text = almostRepeating(300_000, every);
    const entries = [E.wordEntry(SALT, "my_name", phrase)];
    let slow = true;
    for (let attempt = 0; attempt < 3 && slow; attempt++) {
      const base = time([], text);
      const all = time(entries, text);
      slow = all > 2.5 * Math.max(base, 150);
      if (slow) {
        console.info(`every ${every}th, ${phrase}: ${Math.round(all)} ms, ${Math.round(base)} ms with no vault`);
      }
    }
    assert.ok(!slow, `every ${every}th copy changed, ${phrase} saved: much slower than with no vault`);
  }
});

test("a long paste that repeats a few characters finds the same saved words as a short one", () => {
  const entries = [
    saved("my_name", "山田太郎"),
    saved("family_name", "田中"),
    saved("my_name", "Ann Lee"),
    saved("employer", "株式会社"),
    saved("my_name", "3年B組3年B組"),
    saved("my_name", "김민수"),
  ];
  const finds = (text) => {
    const found = detectAfresh(entries, text);
    C.setVault(null);
    return [
      ...new Set(found.filter((r) => ["my_name", "family_name", "employer"].includes(r.id)).flatMap((r) => r.matches)),
    ].sort();
  };
  for (const unit of ["3年B組", "山", "ab", "Ann Lee, ", "株式会社", "김"]) {
    for (const word of ["", "山田太郎", "田中さん", "Ann Lee", "株式会社山田", "김민수씨"]) {
      for (const at of [0, 0.5, 1]) {
        const make = (size) => {
          const copies = Math.ceil(size / unit.length);
          const left = Math.floor(copies * at);
          return `連絡 ${unit.repeat(left)}${word}${unit.repeat(copies - left)} 以上`;
        };
        assert.deepEqual(finds(make(12_000)), finds(make(600)), `${unit} with ${word || "nothing"} at ${at}`);
      }
    }
  }
});

test("how many saved lengths there are doesn't multiply the lookups in Chinese text that never repeats", () => {
  const text = randomChinese(30_000);
  const one = fingerprintsFor([saved("employer", "株式会")], text);
  const all = fingerprintsFor(everyLength(), text);
  assert.ok(all < one * 2 + 5000, `63 lengths: ${all} fingerprints, one length: ${one}`);
  // A word is still found anywhere in it, whatever its length.
  for (const n of [2, 3, 9, 30, 64]) {
    const word = LONG_CJK.slice(0, n);
    const at = 7_000 + n * 13;
    const withWord = `${text.slice(0, at)}${word}${text.slice(at)}`;
    withVault(everyLength(), () => {
      const found = C.detect(withWord);
      assert.ok(
        found.some((r) => r.id === "employer" && r.matches.includes(word)),
        `${n} letters: ${JSON.stringify(found.map((r) => r.id))}`,
      );
    });
  }
});

test("a saved Korean name is not found inside a longer Korean word (receipt, democracy, eraser)", () => {
  for (const [name, text] of [
    ["영수", "영수증 좀 주세요"],
    ["민주", "민주주의는 중요하다"],
    ["민수", "국민수준이 높다"],
    ["지우", "지우개를 빌려줘"],
    ["지훈", "지훈련 계획"],
    ["서준", "문서준비"],
    ["현우", "표현우선"],
    ["성민", "구성민원"],
    ["은지", "그것은지금"],
    ["도현", "정도현상"],
  ]) {
    withVault([saved("family_name", name)], () => {
      const found = C.detect(text);
      assert.ok(!found.some((r) => r.id === "family_name"), `${name} in ${text}: ${JSON.stringify(found)}`);
    });
  }
  // Written straight after a family name, or with particles or a title after it, it still is.
  for (const [name, text, want] of [
    ["민수", "김민수가 왔다", `김${LABEL.family_name}가 왔다`],
    ["민수", "김민수입니다", `김${LABEL.family_name}입니다`],
    ["민수", "김민수는 학생", `김${LABEL.family_name}는 학생`],
    ["민수", "김민수 씨", `김${LABEL.family_name} 씨`],
    ["민수", "민수야 밥 먹자", `${LABEL.family_name}야 밥 먹자`],
    ["영수", "영수에게 전해줘", `${LABEL.family_name}에게 전해줘`],
    ["김민수", "김민수님께서", `${LABEL.family_name}님께서`],
  ]) {
    withVault([saved("family_name", name)], () => covers(text, "family_name", want));
  }
  // A saved word that mixes Korean with digits is found inside a longer word, as before.
  withVault([saved("my_name", "101동1203호")], () =>
    covers("주소: 101동1203호실", "my_name", `주소: ${LABEL.my_name}실`),
  );
});

test("a saved Korean name written straight before or after Chinese or Japanese letters is still found", () => {
  withVault([saved("family_name", "김민수")], () => {
    covers("김민수長天", "family_name", `${LABEL.family_name}長天`);
    covers("・김민수山田 太郎", "family_name", `・${LABEL.family_name}山田 太郎`);
    covers("の김민수社1", "family_name", `の${LABEL.family_name}社1`);
    covers("山김민수가社", "family_name", `山${LABEL.family_name}가社`);
  });
  // The Korean letters straight after it still have to be the end of the word or particles.
  withVault([saved("family_name", "영수")], () => {
    const found = C.detect("영수증山");
    assert.ok(!found.some((r) => r.id === "family_name"), JSON.stringify(found));
  });
});

test("a saved Japanese or Chinese name with a letter outside the basic plane (𠮷) is found inside a sentence", () => {
  assert.equal(saved("employer", "𠮷野家").closed, 3);
  withVault([saved("employer", "𠮷野家")], () => {
    covers("私は𠮷野家でバイトしています", "employer", `私は${LABEL_EMPLOYER}でバイトしています`);
    covers("𠮷野家", "employer", LABEL_EMPLOYER);
  });
});

test("runs that start a great many saved words, each in new text, stop at a budget: the scan says so and goes on", () => {
  // Every saved word starts with "株式", and each copy of it here is followed by a letter not seen before it.
  let text = "";
  for (let i = 0; text.length < 30_000; i++) text += `株式${String.fromCharCode(0x4e00 + ((i * 7919) % 20_000))}`;
  const email = ["jane.doe", "example.com"].join("@");
  const fingerprints = fingerprintsFor(everyLength(), `${text} ${email}`);
  assert.ok(fingerprints < 150_000, `${fingerprints} fingerprints`);
  const found = detectAfresh(everyLength(), `${text} ${email}`);
  C.setVault(null);
  assert.ok(found.truncated, "a scan that left runs unread says it was cut short");
  assert.ok(
    found.some((r) => r.id === "email"),
    "the rest of the scan still ran",
  );
  // A saved word before the budget ran out is still found.
  const word = LONG_CJK.slice(0, 12);
  withVault(everyLength(), () => {
    const early = C.detect(`私は${word}です。${text}`);
    assert.ok(early.some((r) => r.id === "employer" && r.matches.includes(word)));
  });
  // Ordinary text with the same words saved is read whole.
  withVault(everyLength(), () => {
    const prose = `${"私は株式会社で働いています。".repeat(2000)}${email}`;
    assert.ok(!C.detect(prose).truncated);
  });
});
