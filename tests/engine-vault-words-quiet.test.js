// Where a saved word's letters only sit beside or inside something else, the vault stays quiet: prose marks between
// two words, a short word in code, a contraction or an elision, an abbreviation glued to Japanese, and Chinese or
// Japanese letters that belong to the words around them. Each shape keeps the finds it was built for.
// Run from the repo root: node --test tests/engine-vault-words-quiet.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect", "decide");

const C = globalThis.Clotr;
const SALT = "s4lt";
const VAULT = new Set(["my_name", "family_name", "employer", "watch_list"]);
const saved = (type, phrase) => C.wordEntry(SALT, type, phrase);
// Saved the way 1.6.1's vault page saved it: a fingerprint and a count of words.
const savedBefore = (type, phrase) => ({
  kind: "word",
  type,
  fp: C.fingerprint(SALT, "watch_list", phrase),
  words: phrase.split(" ").length,
});

function vaultFinds(entry, text) {
  C.setVault({ salt: SALT, entries: [entry] });
  try {
    return C.detect(text)
      .filter((r) => VAULT.has(r.id))
      .flatMap((r) => r.matches);
  } finally {
    C.setVault(null);
  }
}

// Each [type, saved word, text] is quiet, with the word saved today and the 1.6.1 way.
function quiet(cases) {
  const wrong = [];
  for (const [type, phrase, text] of cases) {
    for (const entry of [saved(type, phrase), savedBefore(type, phrase)]) {
      const got = vaultFinds(entry, text);
      if (got.length) wrong.push(`${phrase} in ${JSON.stringify(text)}: ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(wrong, []);
}

// Each [type, saved word, text, found as] is found, with the word saved today.
function finds(cases) {
  const wrong = [];
  for (const [type, phrase, text, as] of cases) {
    const got = vaultFinds(saved(type, phrase), text);
    if (JSON.stringify(got) !== JSON.stringify([as])) {
      wrong.push(`${phrase} in ${JSON.stringify(text)}: ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(wrong, []);
}

test("a comma, semicolon or colon with a space, a spaced dash or slash, or a new list item ends a saved name", () => {
  quiet([
    ["my_name", "June Carter", "In June, Carter said the plan was fine."],
    ["my_name", "Rose Hill", "Prices rose, Hill noted in the report."],
    ["my_name", "Grace Lee", "By some grace, Lee got the visa in time."],
    ["my_name", "Mark Young", "We missed the mark; Young players did better."],
    ["my_name", "Hope Davis", "Our one hope: Davis signs before Friday."],
    ["my_name", "Will Smith", "It will - Smith says - ship on Friday."],
    ["my_name", "Ann Smith", "Thanks to Ann, Smith and Lee for reviewing it."],
    ["my_name", "May Lee", "Due in May / Lee owns it"],
    ["my_name", "Ann Lee", "Team:\n- Ann\n- Lee\n- Bob"],
    ["my_name", "Ann Lee", "- Ann\n- Lee"],
    // Mine.
    ["my_name", "Rose Park", "The price rose; Park Street got busier."],
    ["my_name", "Faith Hill", "Keep the faith: Hill climbs are hard."],
    ["my_name", "Ann Lee", "Ask Ann – Lee is away."],
    ["my_name", "Ann Lee", "Ask Ann — Lee is away."],
    ["my_name", "Jack Long", "Sizes: jack, Long, short"],
    ["my_name", "Ann Lee", "1. Ann\n2. Lee"],
    ["my_name", "Ann Lee", "* Ann\n* Lee"],
    ["my_name", "Ann Lee", "| Ann |\n| Lee |"],
    ["my_name", "June Carter", "Due: June,\tCarter to check"],
  ]);
});

test("Markdown, CSV and path marks between a saved name's words still find it, and so do cells side by side", () => {
  finds([
    ["my_name", "Ann Smith", "**Ann** Smith wrote back", "Ann** Smith"],
    ["my_name", "Ann Smith", "id,Ann,Smith,2024", "Ann,Smith"],
    ["my_name", "Ann Smith", "C:/Users/Ann/Smith/notes.txt", "Ann/Smith"],
    ["my_name", "Lena Ortiz", '"Lena";"Ortiz";42', 'Lena";"Ortiz'],
    ["my_name", "Lena Ortiz", "D:\\Lena\\Ortiz\\tax.pdf", "Lena\\Ortiz"],
    ["my_name", "Ann Smith", "Ann\nSmith", "Ann\nSmith"],
  ]);
});

test("a saved name split across cells isn't found under a header that names other things or from an everyday word", () => {
  quiet([
    ["my_name", "June Carter", "| Month | Owner |\n|---|---|\n| June | Carter |"],
    ["my_name", "June Carter", "month,owner\nJune,Carter\nJuly,Nguyen"],
    ["my_name", "June Carter", "<tr><td>June</td><td>Carter</td></tr>"],
    // Mine.
    ["my_name", "June Carter", "| Month | Owner |\n| :-- | --: |\n| May | Lee |\n| June | Carter |"],
    ["my_name", "June Carter", "| June | Carter |"],
    ["my_name", "June Carter", "month;owner\nJune;Carter"],
    ["my_name", "Lena Ortiz", "| Day | City |\n|---|---|\n| Lena | Ortiz |"],
    ["my_name", "Lena Ortiz", "day,city\nLena,Ortiz"],
    ["my_name", "Priya Shah", "owner,reviewer\nPriya,Shah"],
    ["my_name", "Page Turner", "| Page | Turner |"],
    ["my_name", "Mark Young", "Mark,Young,2024"],
    ["my_name", "Bill Price", "<tr><td>Bill</td><td>Price</td></tr>"],
    ["my_name", "Grace Lee", '"Grace";"Lee";42'],
    ["my_name", "June Carter", "<table><tr><td>June</td>\n<td>Carter</td></tr></table>"],
  ]);
});

test("a saved name split across cells is found under a header that names a name, or with no header", () => {
  finds([
    ["my_name", "Ann Smith", "| Ann | Smith |", "Ann | Smith"],
    ["my_name", "Ann Smith", "id,Ann,Smith,2024", "Ann,Smith"],
    ["my_name", "Lena Ortiz", "7,Lena,Ortiz,lena@x.test", "Lena,Ortiz"],
    ["my_name", "Lena Ortiz", '"Lena";"Ortiz";42', 'Lena";"Ortiz'],
    ["my_name", "Lena Ortiz", "<p>Lena<br>Ortiz</p>", "Lena<br>Ortiz"],
    // Mine.
    ["my_name", "June Carter", "| First | Last |\n|---|---|\n| June | Carter |", "June | Carter"],
    ["my_name", "June Carter", "first_name,last_name\nJune,Carter", "June,Carter"],
    ["my_name", "Grace Lee", "First Name,Last Name\nGrace,Lee", "Grace,Lee"],
    ["my_name", "Mark Young", "| # | Given name | Family name |\n|---|---|---|\n| 3 | Mark | Young |", "Mark | Young"],
    ["my_name", "Priya Shah", "<tr><td>Priya</td><td>Shah</td></tr>", "Priya</td><td>Shah"],
    ["my_name", "Lena Ortiz", "Lena,Ortiz\nJune,Carter", "Lena,Ortiz"],
    ["my_name", "Lena Ortiz", "June,Carter\nLena,Ortiz", "Lena,Ortiz"],
    ["my_name", "Lena Ortiz", "| Lena | Ortiz |\n| June | Carter |", "Lena | Ortiz"],
    ["my_name", "Lena Ortiz", "| Month | Owner |\n|---|---|\n| June | Lena Ortiz |", "Lena Ortiz"],
  ]);
});

test("a short word is never a saved name as one piece of a code name or beside a digit", () => {
  quiet([
    ["my_name", "Max", "const top = Math.max(a, b);"],
    ["my_name", "Max", 'client.messages.create(model="x", max_tokens=1024)'],
    ["my_name", "Max", "MAX_RETRIES = 3"],
    ["my_name", "Grant", "body: grant_type=client_credentials&scope=read"],
    ["my_name", "Ray", "settings.ray_tracing = true"],
    ["family_name", "Page", "GET /items?page_size=50"],
    ["family_name", "Page", "const next = res.data.next_page;"],
    ["family_name", "Price", "SELECT item.price FROM orders"],
    ["family_name", "Field", "form.field_name.value"],
    ["family_name", "Long", "long_description: str"],
    ["family_name", "Lane", "lane_id INTEGER NOT NULL"],
    ["family_name", "King", "bed_type = king_size"],
    ["my_name", "Bill", "UPDATE invoices SET bill_id = 7"],
    ["my_name", "Ed", "ssh-keygen -t ed25519 -C laptop"],
    ["my_name", "Ed", "cat ~/.ssh/id_ed25519.pub"],
    ["my_name", "Al", "fired in an Al2O3 crucible"],
    ["my_name", "Win", "import win32api"],
    ["my_name", "Sha", "sha256sum release.zip"],
    ["my_name", "Vue", "npm i vue3-router"],
    // Mine.
    ["family_name", "Key", "export API_KEY=abc"],
    ["family_name", "Read", "fs.read_file(path)"],
    ["family_name", "Hash", "hash.update(data)"],
    ["family_name", "Page", "PAGE_SIZE = 20"],
    ["family_name", "Young", "df.young_count"],
    ["my_name", "Mark", "git.mark_done()"],
    ["my_name", "Max", "int max2 = 0;"],
    ["my_name", "Ian", "ian2024"],
    ["my_name", "Lin", "x86_64-linux"],
  ]);
});

test("a person's name is never one piece of a code name, nor a word beside a version or a room number", () => {
  quiet([
    ["family_name", "Hunter", "from tools import hunter_config"],
    ["my_name", "Hunter", "HUNTER_API_TIMEOUT=30"],
    ["my_name", "Taylor", "y = taylor_series(x, 5)"],
    ["family_name", "Walker", "tree_walker.visit(node)"],
    ["my_name", "Cherry", "def cherry_pick(commit):"],
    ["family_name", "Fisher", "random.fisher_yates(items)"],
    ["family_name", "Miller", "assert miller_rabin(n)"],
    ["family_name", "Holder", "card_holder_name = form.name"],
    ["my_name", "Summer", "show_summer_sale = True"],
    ["family_name", "Porter", "stem = porter_stemmer(word)"],
    ["my_name", "Parker", "parser = config.parker_mode"],
    ["family_name", "Turner", "self.page_turner.next()"],
    ["family_name", "Page", "see page2.html for details"],
    ["my_name", "Mark", "release mark2 next week"],
    ["family_name", "Ward", "patient moved to ward3b"],
    ["my_name", "Gemma", "ollama pull gemma3:12b"],
    ["my_name", "Rocky", "FROM rocky9-minimal"],
    ["my_name", "Alma", "base: alma9"],
    ["my_name", "Ruby", "uses: ruby3.3"],
    ["family_name", "Lane", "merge into lane2 at the exit"],
    ["family_name", "Hall", "meet in hall4b"],
    // Mine.
    ["family_name", "Carter", "CARTER_ENDPOINT = '/v2'"],
    ["family_name", "Cooper", "cooper_test.run()"],
    ["my_name", "Archer", "import archer_utils"],
    ["family_name", "Baker", "baker_street.csv"],
    ["family_name", "Foster", "self.foster_count += 1"],
    ["my_name", "Hazel", "colors.hazel_light"],
    ["my_name", "River", "river3d.render()"],
    ["my_name", "Jade", "jade4j template"],
    ["family_name", "Rowe", "rowe7 is the build host"],
    ["my_name", "Rose", "rose2-bloom.png"],
  ]);
});

test("a longer saved word is still found as a piece of a code name, a host, or a username", () => {
  finds([
    ["employer", "Initech", "export INITECH_API=1", "INITECH"],
    ["employer", "Initech", "see initech.com/careers", "initech"],
    ["employer", "Vandelay", "VANDELAY_DB_URL=postgres://x", "VANDELAY"],
    ["employer", "Vandelay", "https://vandelay.example/jobs", "vandelay"],
    ["family_name", "Smith", "login smith1990 please", "smith"],
    ["family_name", "Ortiz", "login: ortiz88", "ortiz"],
    ["my_name", "Ann Smith", "ann.smith@example.com wrote", "ann.smith"],
    ["my_name", "Ann Smith", "follow @ann_smith", "ann_smith"],
    ["my_name", "Lena Ortiz", "const lenaOrtizId = 4;", "lenaOrtiz"],
    // Mine.
    ["family_name", "Kowalski", "login kowalski77 please", "kowalski"],
    ["my_name", "Ann Smith", "AnnSmith1990 joined", "AnnSmith"],
    ["my_name", "Lena Ortiz", "lena_ortiz_resume.pdf", "lena_ortiz"],
    ["employer", "Initech", "const INITECH_BASE = '/api';", "INITECH"],
    ["watch_list", "Vandelay", "vandelay_imports.csv", "vandelay"],
  ]);
});

test("an elision or a contraction is never a saved word with its apostrophe dropped", () => {
  quiet([
    ["my_name", "Jai", "J'ai besoin d'aide pour ce code."],
    ["my_name", "Jai", "J’ai fini le rapport hier."],
    ["my_name", "Jen", "J'en ai besoin demain matin."],
    ["employer", "Nest", "Ce n'est pas grave."],
    ["my_name", "Dun", "C'est le début d'un projet."],
    ["my_name", "Sil", "Dis-moi s'il te plaît."],
    ["my_name", "Quil", "Il faut qu'il parte."],
    ["my_name", "Yall", "Thanks y'all for coming"],
    ["my_name", "Oclock", "See you at 5 o'clock"],
    // Mine.
    ["my_name", "Lami", "C'est l'ami de Paul."],
    ["employer", "Cest", "C’est la vie."],
    ["my_name", "Quelle", "Qu'elle vienne."],
    ["my_name", "Lacqua", "Bevo l'acqua."],
    ["my_name", "Jaime", "J'aime le café."],
  ]);
});

test("a name written with its apostrophe, without it, or with another mark is still found", () => {
  finds([
    ["my_name", "Liam O'Brien", "Liam O`Brien called", "Liam O`Brien"],
    ["my_name", "Liam O'Brien", "Liam OBrien called", "Liam OBrien"],
    ["my_name", "Liam O'Brien", "Liam O’Brien called", "Liam O’Brien"],
    ["family_name", "O'Neil", "Cheers, Shaun ONeil", "ONeil"],
    ["family_name", "D'Angelo", "Ask DAngelo", "DAngelo"],
    ["family_name", "D'Angelo", "Ask D’Angelo", "D’Angelo"],
    ["my_name", "Ann", "Ann's laptop", "Ann"],
  ]);
});

test("a name saved as a letter, an apostrophe and a capital is found in any case and with any apostrophe", () => {
  const names = [
    ["family_name", "O'Brien"],
    ["family_name", "O’Brien"],
    ["family_name", "D'Angelo"],
    ["family_name", "O'Neil"],
    ["family_name", "D'Souza"],
    ["my_name", "N'Golo Kante"],
    ["my_name", "Shaquille O'Neal"],
    ["employer", "L'Oréal"],
    ["my_name", "T.J. O'Neil"],
    // Mine.
    ["family_name", "D'Arcy"],
    ["family_name", "O'Hara"],
    ["my_name", "Maeve O'Sullivan"],
  ];
  const typed = (name) => {
    const lower = name.toLowerCase();
    const titled = name.replace(/(['’])(\p{Lu})/u, (_m, mark, ch) => mark + ch.toLowerCase());
    return [lower, titled, name.toUpperCase()].flatMap((form) =>
      ["'", "’", "ʼ", "`"].map((mark) => form.replace(/['’]/g, mark)),
    );
  };
  const cases = [];
  for (const [type, name] of names) {
    for (const form of typed(name)) cases.push([type, name, `call ${form} today`, form]);
    cases.push([type, name, `Hi ${name.replace(/['’]/g, "")}, thanks`, name.replace(/['’]/g, "")]);
  }
  finds(cases);
  finds([
    ["family_name", "O'Brien", "call ｏ＇ｂｒｉｅｎ today", "ｏ＇ｂｒｉｅｎ"],
    ["family_name", "Ｏ＇Ｂｒｉｅｎ", "call ｏ＇ｂｒｉｅｎ today", "ｏ＇ｂｒｉｅｎ"],
    ["family_name", "O'Brien", "Hi d’angelo and o'brien, thanks", "o'brien"],
  ]);
});

test("an elision in capitals is never a saved word with its apostrophe dropped", () => {
  quiet([
    ["my_name", "Jai", "J'AI FAIM"],
    ["my_name", "Jen", "J'EN AI MARRE"],
    ["family_name", "Lai", "JE L'AI VU HIER"],
    ["my_name", "Lan", "L'AN DERNIER"],
    ["my_name", "Den", "D'EN HAUT"],
    ["my_name", "Yall", "Y'ALL READY?"],
    ["my_name", "Cest", "C'EST LA VIE"],
    ["my_name", "Quil", "QU'IL VIENNE"],
    ["my_name", "Sil", "S'IL VOUS PLAÎT"],
    ["my_name", "Lami", "L'Ami de Paris"],
    // Mine.
    ["employer", "Nest", "CE N'EST PAS GRAVE"],
    ["my_name", "Daccord", "D'ACCORD, À DEMAIN"],
    ["my_name", "Mappelle", "JE M'APPELLE PAUL"],
    ["my_name", "Oclock", "AT 5 O'CLOCK"],
    ["my_name", "Lacqua", "L’Acqua di Parma"],
    ["employer", "Quelle", "QU’ELLE VIENNE"],
    ["my_name", "Jai", "J`AI FINI"],
  ]);
});

test("a Latin word in capitals glued to Chinese or Japanese is part of the compound, a name glued to them isn't", () => {
  quiet([
    ["my_name", "Max", "MAX値を超えたらエラーにする"],
    // Mine.
    ["my_name", "Max", "上限はMAXです"],
    ["family_name", "Page", "PAGE数を確認"],
    ["employer", "Usb", "USBメモリを買った"],
    ["my_name", "Max", "超过MAX值就报错"],
  ]);
  finds([
    ["my_name", "Ann", "社員Ann", "Ann"],
    ["my_name", "Ann", "我叫Ann。", "Ann"],
    ["my_name", "Ann", "Annさん、こんにちは", "Ann"],
    ["my_name", "Ann", "Ann的电话是多少", "Ann"],
    ["family_name", "Smith", "Smith様", "Smith"],
  ]);
});

test("a Latin word in small letters glued to Chinese or Japanese is part of the compound, unless a title follows", () => {
  quiet([
    ["my_name", "Max", "max値を超えたらエラー"],
    ["my_name", "Max", "Max値を設定"],
    ["family_name", "Page", "page数を数える"],
    ["my_name", "Max", "超过max值就报错"],
    ["my_name", "Mark", "mark済みにする"],
    ["my_name", "Bill", "bill番号を入力"],
    // Mine.
    ["my_name", "Max", "max長さを確認"],
    ["family_name", "Page", "最大page数は10です"],
    ["my_name", "Bill", "bill金额是多少"],
    ["my_name", "Mark", "mark付けしておく"],
    ["my_name", "Max", "Max值是多少"],
  ]);
  finds([
    ["family_name", "Smith", "Smith様、ありがとうございます", "Smith"],
    ["my_name", "Ann", "Ann的电话是多少", "Ann"],
    ["my_name", "Ann", "社員Ann", "Ann"],
    ["my_name", "Ann", "我叫Ann。", "Ann"],
    ["my_name", "Ann", "Annさん、こんにちは", "Ann"],
    // Mine.
    ["my_name", "Ann", "Ann说她明天来", "Ann"],
    ["family_name", "Smith", "Smith先生您好", "Smith"],
    ["my_name", "Ann", "Ann老师好", "Ann"],
    ["my_name", "Tom", "Tom君へ", "Tom"],
    ["my_name", "Ann", "Ann部長に確認します", "Ann"],
    ["family_name", "Smith", "Smith氏によると", "Smith"],
  ]);
});

test("a saved Chinese or Japanese name isn't found across the edge of the words around it", () => {
  quiet([
    ["family_name", "山本", "来週、富山本社に行きます。"],
    ["family_name", "山本", "岡山本店で新しいパンを買いました。"],
    ["family_name", "山本", "松山本町の会議室を予約しました。"],
    ["family_name", "田中", "秋田中央道路が混んでいました。"],
    ["family_name", "前田", "駅前田中ビルの3階です。"],
    ["family_name", "本田", "日本田舎暮らしの本を読んでいます。"],
    ["family_name", "森田", "青森田舎館村の田んぼアートを見た。"],
    ["family_name", "大野", "この町には大野球場がある。"],
    ["family_name", "中山", "祭りの日は町中山車でいっぱいだ。"],
    ["my_name", "明日香", "明日香りのいいコーヒーを買います。"],
    ["my_name", "健一", "保健一般の質問です。"],
    ["my_name", "正人", "公正人事制度について説明します。"],
    ["my_name", "王明", "小王明天来北京。"],
    ["my_name", "李明", "老李明天要出差。"],
    ["my_name", "张明", "小张明天到上海。"],
    ["my_name", "陈静", "小陈静静地坐在那里。"],
    ["my_name", "张华", "公司计划扩张华南市场。"],
    ["my_name", "刘强", "小刘强调了这一点。"],
    ["my_name", "王强", "老王强调安全第一。"],
    ["my_name", "周明", "我们每周明确一次目标。"],
    // Mine.
    ["family_name", "山本", "富山本社"],
    ["family_name", "田中", "秋田中央"],
    ["my_name", "王明", "小王明天"],
    ["family_name", "川口", "品川口座"],
    ["my_name", "李明", "老李明白了"],
  ]);
});

test("a saved Chinese or Japanese name is still found beside particles, titles and other words", () => {
  finds([
    ["family_name", "田中", "田中さんに資料を送りました。", "田中"],
    ["family_name", "山本", "山本様、お世話になっております。", "山本"],
    ["my_name", "山田太郎", "担当の山田太郎です。よろしくお願いします。", "山田太郎"],
    ["my_name", "明日香", "明日香さんは明日来ます。", "明日香"],
    ["my_name", "王明", "我叫王明，是新来的。", "王明"],
    ["my_name", "陈静", "陈静老师明天请假。", "陈静"],
    ["my_name", "刘强", "请联系刘强经理。", "刘强"],
    ["my_name", "李小龙", "请转告李小龙明早开会", "李小龙"],
    ["my_name", "佐藤花子", "お客様の佐藤花子様より", "佐藤花子"],
    ["my_name", "山田太郎", "私は山田 太郎です", "山田 太郎"],
    ["my_name", "山田太郎", "山田太郎君", "山田太郎"],
    ["employer", "株式会社山田", "株式会社山田製作所の件", "株式会社山田"],
    ["watch_list", "3年B組", "私は3年B組です", "3年B組"],
    ["my_name", "王伟", "王伟说他明天来", "王伟"],
    ["family_name", "鈴木", "鈴木課長の件", "鈴木"],
  ]);
});

test("a saved Chinese name right after 小, 老 or 阿 is the surname they're said with, not the name", () => {
  quiet([
    ["my_name", "陈晨", "小陈晨跑去了。"],
    ["my_name", "杨光", "小杨光着脚跑。"],
    ["my_name", "马丽", "老马丽江旅游去了。"],
    // Mine.
    ["my_name", "张云", "小张云游四海。"],
    ["my_name", "李晨", "老李晨练去了。"],
    ["my_name", "刘春", "阿刘春游去了。"],
    ["my_name", "陈明", "小陈明早去了。"],
  ]);
  finds([
    ["my_name", "陈晨", "从小陈晨就喜欢画画。", "陈晨"],
    ["my_name", "王明", "老师王明说明天考试。", "王明"],
    ["my_name", "陈晨", "我叫陈晨，是新来的。", "陈晨"],
  ]);
});

test("a two-letter Chinese or Japanese word glued between others is a saved name only before a title", () => {
  quiet([
    ["family_name", "高峰", "早高峰的地铁很挤。"],
    // Mine.
    ["my_name", "高峰", "晚高峰的公交车很慢。"],
    ["my_name", "高峰", "下班高峰时段很堵。"],
    ["my_name", "文明", "讲文明的城市。"],
    ["family_name", "中村", "山中村役場に行く。"],
  ]);
  finds([
    ["my_name", "高峰", "我叫高峰。", "高峰"],
    ["my_name", "高峰", "高峰说他今天不来。", "高峰"],
    ["my_name", "高峰", "请联系高峰经理。", "高峰"],
    ["my_name", "王明", "我和王明是同事。", "王明"],
    ["my_name", "张伟", "告诉张伟明天开会", "张伟"],
    ["family_name", "田中", "営業部田中部長に確認", "田中"],
    ["family_name", "田中", "営業部田中です。", "田中"],
  ]);
});

test("a two-letter Korean word that starts a word is a saved name before a title, a call or a particle for people", () => {
  quiet([
    ["my_name", "지은", "이 책의 지은이는 누구예요?"],
    ["my_name", "박수", "모두 박수를 쳤어요."],
    // Mine.
    ["my_name", "하늘", "오늘은 하늘이 맑아요."],
    ["my_name", "수정", "파일 수정이 끝났어요."],
    ["my_name", "정수", "변수에 정수를 넣으세요."],
    ["my_name", "박수", "그건 박수야."],
  ]);
  finds([
    ["my_name", "지은", "지은 씨, 내일 봐요.", "지은"],
    ["my_name", "지은", "지은씨에게 보냈어요.", "지은"],
    ["my_name", "지은", "지은아, 밥 먹자.", "지은"],
    ["my_name", "지은", "지은이에게 전해 줘.", "지은"],
    ["my_name", "박수", "박수님께 보냈어요.", "박수"],
    ["family_name", "민수", "민수야 밥 먹자", "민수"],
    ["family_name", "영수", "영수에게 전해줘", "영수"],
    ["family_name", "민수", "김민수가 왔다", "민수"],
    ["my_name", "김민수", "김민수가 왔어요.", "김민수"],
  ]);
});

test("a name saved with an apostrophe is found when it's typed without one, and elisions stay quiet", () => {
  finds([
    ["family_name", "O'Brien", "Obrien called today.", "Obrien"],
    ["family_name", "O'Brien", "I met Obrien yesterday.", "Obrien"],
    ["family_name", "O'Brien", "Please ask Obrien to call.", "Obrien"],
    ["family_name", "O'Brien", "Liam OBrien called", "OBrien"],
    ["family_name", "O'Brien", "follow @obrien for updates", "obrien"],
  ]);
  quiet([
    ["my_name", "Jai", "J'ai besoin d'aide."],
    ["my_name", "Shell", "She'll call you back."],
    ["my_name", "Jai", "J'AI FAIM"],
    ["my_name", "Lan", "L'AN DERNIER"],
    ["my_name", "Cest", "C'EST LA VIE"],
  ]);
});

test("a saved employer or other word is found across cells, glued in Chinese or before any Korean particle", () => {
  finds([
    ["employer", "삼성", "삼성에서 일해요.", "삼성"],
    ["employer", "高峰", "我在高峰上班。", "高峰"],
    ["watch_list", "联系", "怎么联系客服？", "联系"],
    ["watch_list", "박수", "모두 박수를 쳤어요.", "박수"],
    ["employer", "Grace Labs", "| Grace | Labs |", "Grace | Labs"],
    ["employer", "Mark Media", "| Brand | Unit |\n| --- | --- |\n| Mark | Media |", "Mark | Media"],
  ]);
});

// Another browser's word data (Firefox's reads "明日香|り" where Node's reads "明日|香り"): a stand-in Intl.Segmenter
// that reads the longest of `words` at each place, and a letter on its own where none fits.
function engineReading(words, seen = () => {}) {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const longest = [...words].sort((a, b) => b.length - a.length);
  class Segmenter {
    segment(s) {
      seen(s);
      const out = [];
      for (let i = 0; i < s.length;) {
        const segment = longest.find((w) => s.startsWith(w, i)) || s[i];
        out.push({ segment, index: i });
        i += segment.length;
      }
      return out;
    }
  }
  const box = vm.createContext({ Intl: Object.create(Intl, { Segmenter: { value: Segmenter } }), console });
  for (const f of require("./load-engine.js").files("rules", "detect", "decide")) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension", f), "utf8"), box, { filename: f });
  }
  return vm.runInContext("globalThis.Clotr", box);
}

test("a saved name read as words of its own where it's found is segmented once there", () => {
  const read = [];
  const E = engineReading(["担当", "山田", "太郎", "です"], (s) => read.push(s));
  E.setVault({ salt: SALT, entries: [E.wordEntry(SALT, "my_name", "山田太郎")] });
  try {
    E.detect.forget();
    const found = [...E.detect("担当は山田太郎です。")].flatMap((r) => (r.id === "my_name" ? [...r.matches] : []));
    assert.deepEqual(found, ["山田太郎"]);
    assert.equal(read.length, 1, read.join(" / "));
  } finally {
    E.setVault(null);
  }
});

test("a saved Chinese or Japanese name isn't found across a word's edge with other word data either", () => {
  const E = engineReading([
    "明日香",
    "明日",
    "香り",
    "いい",
    "コーヒー",
    "買い",
    "ます",
    "小林旭",
    "小林",
    "旭川",
    "大野",
    "野球場",
  ]);
  const readBy = (phrase, text) => {
    E.setVault({ salt: SALT, entries: [E.wordEntry(SALT, "my_name", phrase)] });
    try {
      // Copied into an array of this test's own, as the engine's comes from its own context.
      return [
        ...E.detect(text)
          .filter((r) => VAULT.has(r.id))
          .flatMap((r) => r.matches),
      ];
    } finally {
      E.setVault(null);
    }
  };
  assert.deepEqual(readBy("明日香", "明日香りのいいコーヒーを買います。"), []);
  assert.deepEqual(readBy("小林旭", "小林旭川店に行った。"), []);
  assert.deepEqual(readBy("大野", "この町には大野球場がある。"), []);
  assert.deepEqual(readBy("明日香", "明日香さんは明日来ます。"), ["明日香"]);
  assert.deepEqual(readBy("小林旭", "担当は小林旭です。"), ["小林旭"]);
});

test("a saved name split across HTML cells is found under a header row that names name parts", () => {
  finds([
    [
      "my_name",
      "June Carter",
      "<table><tr><th>First</th><th>Last</th></tr><tr><td>June</td><td>Carter</td></tr></table>",
      "June</td><td>Carter",
    ],
    // Mine.
    [
      "my_name",
      "Mark Young",
      "<table>\n<thead><tr><th>#</th><th>First name</th><th>Last name</th></tr></thead>\n" +
        "<tbody><tr><td>3</td><td>Mark</td><td>Young</td></tr></tbody></table>",
      "Mark</td><td>Young",
    ],
    [
      "my_name",
      "Grace Lee",
      '<TABLE><TR><TH class="h">first_name</TH><TH>last_name</TH></TR><TR><TD>Grace</TD><TD>Lee</TD></TR></TABLE>',
      "Grace</TD><TD>Lee",
    ],
    [
      "my_name",
      "June Carter",
      "<tr><th>First</th><th>Last</th></tr><tr><td>Ann</td><td>Lee</td></tr><tr><td>June</td><td>Carter</td></tr>",
      "June</td><td>Carter",
    ],
    ["my_name", "Page Turner", "| first_name | last_name |\n|---|---|\n| Page | Turner |", "Page | Turner"],
    ["my_name", "Mark Young", "First,Last\nMark,Young", "Mark,Young"],
  ]);
  quiet([
    [
      "my_name",
      "June Carter",
      "<table><tr><th>Month</th><th>Owner</th></tr><tr><td>June</td><td>Carter</td></tr></table>",
    ],
    ["my_name", "June Carter", "<tr><td>June</td><td>Carter</td></tr>"],
    // Mine.
    [
      "my_name",
      "June Carter",
      "<table><tr><th>First</th><th>Last</th></tr></table><table><tr><td>June</td><td>Carter</td></tr></table>",
    ],
    [
      "my_name",
      "June Carter",
      "<tr><th>First</th><th>Month</th><th>Owner</th></tr><tr><td>Ann</td><td>June</td><td>Carter</td></tr>",
    ],
    ["my_name", "Mark Young", "<tr><th>Item</th><th>Brand</th></tr><tr><td>Mark</td><td>Young</td></tr>"],
  ]);
});

test("a two-letter Korean name that opens a sentence is found before a subject, topic or object particle", () => {
  finds([
    ["my_name", "지은", "지은이가 도착했어요.", "지은"],
    ["my_name", "지은", "지은은 학생이에요.", "지은"],
    ["my_name", "지은", "지은을 만났어요.", "지은"],
    ["my_name", "민수", "민수가 왔어요.", "민수"],
    ["my_name", "민수", "민수를 만났어요.", "민수"],
    // Mine.
    ["my_name", "지은", "지은이 왔어요.", "지은"],
    ["my_name", "지은", "지은이를 봤어요.", "지은"],
    ["my_name", "민수", "민수는 학생이에요.", "민수"],
    ["family_name", "영수", "어제요. 영수가 전화했어요.", "영수"],
    ["my_name", "지은", "오늘 회의는 끝났어요.\n지은은 내일 와요.", "지은"],
    ["my_name", "민수", '"민수를 봤어?"', "민수"],
  ]);
  quiet([
    ["my_name", "지은", "이 책의 지은이는 누구예요?"],
    ["my_name", "박수", "모두 박수를 쳤어요."],
    // Mine.
    ["my_name", "지은", "이 글의 지은이는 누구예요?"],
    ["my_name", "박수", "관객들이 박수를 오래 쳤다."],
    ["my_name", "정수", "두 정수를 입력하세요."],
    ["my_name", "하늘", "오늘은 하늘이 맑아요."],
    ["my_name", "민수", "민수입니다."],
    ["my_name", "박수", "박수도 쳤어요."],
    ["my_name", "지은", "지은이는"],
    ["my_name", "박수", "박수를"],
    ["my_name", "민수", "민수가\n지은이는"],
  ]);
});
