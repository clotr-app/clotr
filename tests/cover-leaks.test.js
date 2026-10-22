// Shapes an outside tester slipped past Cover it, each written the way they pasted it (every value is made up).
// Run from the repo root:  node --test tests/cover-leaks.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const AKIA = "AKIA4HPQ7XZ2R6TWLJ3N";
const AWS_SECRET = ["q7Vb2Rk9", "LmT4xWz8", "Np3Hs6Jd", "1Fc5Gy0U", "a7Ee2Io9"].join("");
const PW = "Tr0ub4dor&3x!Qz";
const HIDDEN = "[REDACTED PASSWORD OR SECRET]";

const cover = (text) => globalThis.Clotr.redact(text, globalThis.Clotr.detect(text));
const found = (text) => globalThis.Clotr.detect(text).flatMap((r) => r.matches);

// What of `secret` is still in `out`: any 8-character run, or a shorter piece of its start or end right against a
// cover label, like the "!Qz" once left in "[REDACTED PASSWORD OR SECRET]!Qz".
function leftOf(secret, out) {
  const plain = (s) => s.replace(/\[REDACTED [^\]]*\]/g, "\u0000").replace(/\\[nrt]|[\s"'\\]/g, "");
  const body = plain(secret);
  const rest = plain(out);
  for (let i = 0; i + 8 <= body.length; i++) if (rest.includes(body.slice(i, i + 8))) return body.slice(i, i + 8);
  for (let k = Math.min(body.length - 1, 7); k >= 2; k--) {
    if (out.includes("]" + secret.slice(-k))) return secret.slice(-k);
    if (out.includes(secret.slice(0, k) + "[")) return secret.slice(0, k);
  }
  return "";
}

function expectGone(text, ...secrets) {
  const out = cover(text);
  for (const secret of secrets) {
    assert.equal(leftOf(secret, out), "", `${JSON.stringify(text)} → ${JSON.stringify(out)}`);
  }
  return out;
}

test("a password with ! ? , ; ' or \" in it is covered whole, in a sentence and after a label", () => {
  for (const [text, out] of [
    [`my password is ${PW}`, `my password is ${HIDDEN}`],
    [`My password is ${PW}.`, `My password is ${HIDDEN}.`],
    [`mi contraseña es ${PW}`, `mi contraseña es ${HIDDEN}`],
    [`the password for the router is ${PW}`, `the password for the router is ${HIDDEN}`],
    [`I changed my password to ${PW} yesterday`, `I changed my password to ${HIDDEN} yesterday`],
    ["DB_PASSWORD=Tr0ub;4dor&3x!Qz", `DB_PASSWORD=${HIDDEN}`],
    [`password = 'Tr0ub"4dor&3x!Qz'`, `password = '${HIDDEN}'`],
  ]) {
    assert.equal(cover(text), out, JSON.stringify(text));
  }
  for (const ch of [",", "?", "!", ";", "'", '"']) {
    const pw = `Blue${ch}Sky42x`;
    for (const text of [`my password is ${pw}`, `password: ${pw}`]) {
      assert.equal(leftOf(pw, cover(text)), "", `${JSON.stringify(text)} → ${JSON.stringify(cover(text))}`);
    }
  }
});

test("a quoted password with spaces is covered to its closing quote", () => {
  assert.equal(cover('the wifi password is "blue sky over 42 hills"'), `the wifi password is "${HIDDEN}"`);
  assert.equal(cover('DB_PASSWORD="blue sky over 42 hills"'), `DB_PASSWORD="${HIDDEN}"`);
});

test("the punctuation after a password still ends it where it ends a sentence or a setting", () => {
  assert.deepEqual(found("my password is hunter22, and I forgot it"), ["hunter22"]);
  assert.deepEqual(found("my password is hunter22!"), ["hunter22"]);
  assert.deepEqual(found('my password is "hunter22", right?'), ["hunter22"]);
  assert.deepEqual(found("my password is hunter22; the old one was worse"), ["hunter22"]);
  const conn = "Server=db;Database=app;User Id=sa;Password=Tr0ub4dor9;Trusted_Connection=False";
  assert.ok(cover(conn).endsWith(`Password=${HIDDEN};Trusted_Connection=False`), cover(conn));
  assert.equal(cover('{"password":"Tr0ub4dor9","user":"bob"}'), `{"password":"${HIDDEN}","user":"bob"}`);
  for (const quiet of [
    "my password is it's complicated",
    "I forgot my password, can you help?",
    "what's the password? I can't remember",
    "the password is don't-share-it-with-anyone",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a password that wraps onto a second line after a hyphen is covered across the line break", () => {
  for (const eol of ["\n", "\r\n"]) {
    assert.equal(cover(`password: Tr0ub4dor&3x!Qz-${eol}Vq8Lm2Wn7`), `password: ${HIDDEN}`);
  }
  assert.equal(cover("password: hunter22-\nThanks for the help"), `password: ${HIDDEN}\nThanks for the help`);
  assert.equal(cover("password: Tr0ub4dor9-\nusername: bob"), `password: ${HIDDEN}\nusername: bob`);
});

// A chat box that keeps each line as its own paragraph (ProseMirror, Lexical) reads back a blank line between the
// lines of one paste, so a wrapped secret has to be found across that too.
test("a secret wrapped onto a second line is covered whole when the box reads a blank line between", () => {
  const github = "gh" + "p_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue";
  const openai = "sk-" + "proj-4fT9xQ2mL7vR1cW8bN3kJ6hY0pZ5sDaE7uG2iO9lK4jH1fC3xV6bM8nQ0wR5tY7Az";
  const body = [
    "MIIEpAIBAAKCAQEA7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue7Io9Pl4Ok6Ij1Uh",
    "8Yg5Tf2Rd9Es3Wa6Qz1Xc8Rt5Yp4Mn8Bv3Zs5Kd0Fj2Ga4Ue7Io9Pl4Ok6Ij1Uh8Y",
  ];
  for (const eol of ["\n\n", "\r\n\r\n"]) {
    assert.equal(cover(`token: ${github.slice(0, 20)}${eol}${github.slice(20)}`), "token: [REDACTED GITHUB TOKEN]");
    assert.equal(cover(`${openai.slice(0, 40)}${eol}${openai.slice(40)}`), "[REDACTED OPENAI API KEY]");
    assert.equal(cover(["-----BEGIN RSA PRIVATE KEY-----", ...body].join(eol)), "[REDACTED PRIVATE KEY]");
    assert.equal(cover(`password: Tr0ub4dor&3x!Qz-${eol}Vq8Lm2Wn7`), `password: ${HIDDEN}`);
  }
  assert.equal(
    cover(["-----BEGIN RSA PRIVATE KEY-----", ...body, "Thanks"].join("\n\n")),
    "[REDACTED PRIVATE KEY]\n\nThanks",
  );
});

// A short line under a key is its last few characters when the key isn't whole without them, and otherwise the
// person's next word.
test("a key's short last line is covered with it, and a word under a whole key stays", () => {
  const github = "gh" + "p_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue";
  const hex = "0x530be9d0dbc135d085c40183871d621415fc8e06a9a948ec0f8379065d2109ab";
  assert.equal(cover(`token: ${github.slice(0, -2)}\n${github.slice(-2)}`), "token: [REDACTED GITHUB TOKEN]");
  assert.equal(cover(`PRIVATE_KEY=${hex.slice(0, -2)}\n${hex.slice(-2)}`), "[REDACTED CRYPTO WALLET SEED OR KEY]");
  assert.equal(cover(`my token is ${github}\nThanks`), "my token is [REDACTED GITHUB TOKEN]\nThanks");
  assert.equal(cover(`secret: ${PW.replace(/\W/g, "")}${AWS_SECRET}\ndone.`), `secret: ${HIDDEN}\ndone.`);
});

// A JSON string or a log keeps a line break or a tab as the two characters \n or \t, which glue a letter onto the
// start of whatever comes next.
test("a secret right after a \\n or \\t escape is covered", () => {
  const github = "gh" + "p_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue";
  const openai = "sk-" + "proj-4fT9xQ2mL7vR1cW8bN3kJ6hY0pZ5sDaE7uG2iO9lK4jH1fC3xV6bM8nQ0wR5tY7Az";
  assert.equal(
    cover(`{"note":"Here is the key:\\n${AKIA}\\nthanks"}`),
    `{"note":"Here is the key:\\n[REDACTED AWS ACCESS KEY]\\nthanks"}`,
  );
  for (const [text, ...secrets] of [
    [`{"keys":"${AKIA}\\nAKIA9JKL7XZ2R6TWLJ3N"}`, AKIA, "AKIA9JKL7XZ2R6TWLJ3N"],
    [`{"row":"prod\\t${github}"}`, github],
    [`{"env":"DEBUG=1\\n${openai}"}`, openai],
    [`{"dotenv":"OPENAI_API_KEY=${openai}\\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET}\\n"}`, openai, AWS_SECRET],
    [`b'${AKIA}\\n'`, AKIA],
    [`{"log":"login ok\\r\\npassword: ${PW}\\r\\n"}`, PW],
  ]) {
    expectGone(text, ...secrets);
  }
  for (const quiet of [
    String.raw`C:\new\temp\notes.txt`,
    String.raw`{"msg":"first line\nsecond line\tthird"}`,
    String.raw`printf("%s\n", name);`,
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

// A log line that holds another program's JSON escapes its backslashes again, so a line break there is \\n.
test("a secret right after a doubly escaped \\\\n is covered", () => {
  const github = "gh" + "p_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue";
  for (const [text, ...secrets] of [
    [String.raw`{"log":"{\"msg\":\"hello\\nAKIA4HPQ7XZ2R6TWLJ3N\"}\n"}`, AKIA],
    [String.raw`level=info msg="token\\n${github}"`, github],
    [String.raw`{"log":"a\\\n${AKIA}"}`, AKIA],
    [String.raw`{"log":"{\"row\":\"prod\\t${github}\"}"}`, github],
  ]) {
    expectGone(text, ...secrets);
  }
  for (const quiet of [String.raw`{"path":"C:\\new\\temp\\notes.txt"}`, String.raw`"first\\nsecond\\tthird"`]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

// A JSON string's \n is a line break, and the value it splits can have a short first line, which a wrap elsewhere
// wouldn't. Cover it once took the whole value here, so it still does.
test("a JSON value split by \\n near its start is covered whole", () => {
  const github = "gh" + "p_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4Ue";
  for (const [text, secret] of [
    [`{"secret":"${AKIA.slice(0, 2)}\\n${AKIA.slice(2)}"}`, AKIA],
    [`{"secret":"${AKIA.slice(0, 7)}\\n${AKIA.slice(7)}"}`, AKIA],
    [`{"token":"${github.slice(0, 7)}\\n${github.slice(7)}"}`, github],
    [`{"password":"${PW.slice(0, 5)}\\n${PW.slice(5)}"}`, PW],
    [`{"secret":"postgres\\n://admin:T65n4CS/nztIJHGE@db.internal:5432/app"}`, "admin:T65n4CS/nztIJHGE"],
  ]) {
    expectGone(text, secret);
  }
  for (const quiet of [String.raw`{"ids":"12345\n67890"}`, String.raw`{"msg":"Hi\nThanks"}`]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a key broken across lines with no label is covered across the break", () => {
  const stripe = "sk_" + "live_51Hq7Lw2Xc9Rt4Yp6Mn1Bv8Zs3Kd5Fj0Ga7Ue2Io9Pl4Ok6Ij1Uh";
  for (const eol of ["\n", "\r\n"]) {
    assert.equal(
      cover(`my key is AKIA4HPQ7X${eol}Z2R6TWLJ3N please fix`),
      "my key is [REDACTED AWS ACCESS KEY] please fix",
    );
  }
  // A shell's "\" and an email's quoted-printable "=" at the end of a line carry the word on to the next one.
  expectGone(`curl https://api.stripe.example/v1/charges -u ${stripe.slice(0, 30)}\\\n${stripe.slice(30)}:`, stripe);
  assert.equal(cover("access key: AKIA4HPQ7X=\nZ2R6TWLJ3N"), "access key: [REDACTED AWS ACCESS KEY]");
  for (const text of ["card number\n4539 1488\n0343 6467", "my card is\n4539\n1488\n0343\n6467"]) {
    assert.deepEqual(found(text).length, 1, text);
    expectGone(text, "4539 1488", "0343 6467");
  }
  // Short numbers one to a line are a list, and a base64 line's "=" is its padding.
  for (const quiet of [
    "4539\n1488\n0343\n6467",
    "Totals:\n4539 1488\n0343 6467",
    "cd C:\\Users\\\nDocuments",
    "AKIA is the prefix\nZ2R6TWLJ3N is not",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("the other common ways of giving a password are covered", () => {
  for (const [text, out] of [
    [`mysql -u root -p${PW} orders`, `mysql -u root -p${HIDDEN} orders`],
    [`Mein Passwort ist ${PW}`, `Mein Passwort ist ${HIDDEN}`],
    [`mon mot de passe est ${PW}`, `mon mot de passe est ${HIDDEN}`],
    [`the admin login is admin and it's ${PW}`, `the admin login is admin and it's ${HIDDEN}`],
    [`use ${PW} as the password`, `use ${HIDDEN} as the password`],
    [`user bob pass ${PW}`, `user bob pass ${HIDDEN}`],
    [`| user | password |\n|---|---|\n| bob | ${PW} |`, `| user | password |\n|---|---|\n| bob | ${HIDDEN} |`],
    [`<password>${PW}</password>`, `<password>${HIDDEN}</password>`],
    [`<input type="password" value="${PW}">`, `<input type="password" value="${HIDDEN}">`],
    [
      `$pw = ConvertTo-SecureString "${PW}" -AsPlainText -Force`,
      `$pw = ConvertTo-SecureString "${HIDDEN}" -AsPlainText -Force`,
    ],
  ]) {
    assert.equal(cover(text), out, JSON.stringify(text));
  }
  for (const quiet of [
    "Mein Passwort ist falsch",
    "mon mot de passe est trop court",
    "the login is broken and it's annoying",
    "the login is broken and it's Friday",
    "use it as the password",
    "use Bitwarden as the password manager",
    "use 1Password2 as the password manager",
    "user John pass Mary the salt",
    "user root pass toor",
    "mysql -u root -p orders",
    "mysql -u root -P 3306 orders",
    "<password/>",
    "<password>${DB_PASSWORD}</password>",
    '<input type="password" value="">',
    '<input type="password" name="pw">',
    "$pw = Read-Host -AsSecureString",
    "| account | password | 2fa |\n|---|---|---|\n| gmail | yes | no |",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("an npm token in .npmrc, a Stripe webhook secret and a card written with dots are covered", () => {
  assert.equal(
    cover("//registry.npmjs.org/:_authToken=npm_7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2Ga4U"),
    "//registry.npmjs.org/:_authToken=[REDACTED SERVICE ACCESS TOKEN]",
  );
  assert.equal(cover("whsec_" + "7Hq2Lw9Xc4Rt6Yp1Mn8Bv3Zs5Kd0Fj2G"), "[REDACTED STRIPE SECRET KEY]");
  assert.equal(cover("4539.1488.0343.6467"), "[REDACTED CREDIT CARD NUMBER]");
  for (const quiet of [
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    "whsec_test",
    "4539.1488.0343.6468",
    "version 2024.1105.0001.0042",
    "pi is 3.1415.9265.3589.7932",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("an AWS secret access key beside its key ID is covered with it", () => {
  for (const text of [
    `Here are the creds you asked for: access key ${AKIA} and secret key\n${AWS_SECRET}`,
    `${AKIA} ${AWS_SECRET}`,
    `| name | value |\n|---|---|\n| key | ${AKIA} |\n| secret | ${AWS_SECRET} |`,
    `${AWS_SECRET}\n${AKIA}`,
  ]) {
    expectGone(text, AKIA, AWS_SECRET);
  }
  // A 40-character hex value is a commit or a checksum, and a secret this far away belongs to something else.
  const sha = "3f9c2e7a1b4d6f8e0a2c4b6d8f0e2a4c6b8d0f2a";
  assert.ok(cover(`${AKIA} was rotated in commit ${sha}`).endsWith(sha));
  const far = `${AKIA}\n${"Unrelated notes about the deploy go here. ".repeat(8)}${AWS_SECRET}`;
  assert.ok(cover(far).endsWith(AWS_SECRET));
});

// A second outside run: other languages, other wrappers and other providers. Every value is made up.
const PW2 = "Vq7#mLp2!xRz";
const PW3 = "Kx9!mQ2vLr";
const HEX32 = "7a29931d9870697868b962e3631e7a18";

test("a password told in another language is covered whole", () => {
  assert.equal(cover(`minha senha é ${PW3} e não consigo entrar`), `minha senha é ${HIDDEN} e não consigo entrar`);
  assert.equal(cover(`我的密码是${PW3}，为什么登录不了`), `我的密码是${HIDDEN}，为什么登录不了`);
  assert.equal(cover(`パスワードは${PW3}です`), `パスワードは${HIDDEN}です`);
  for (const text of [
    `la mia password è ${PW3}, puoi aiutarmi?`,
    `usuário: pquinn\nsenha: ${PW3}`,
    `mijn wachtwoord is ${PW3}`,
    `moje hasło to ${PW3}`,
    `şifrem ${PW3} ama giriş yapamıyorum`,
    `мой пароль ${PW3}, помогите`,
    `мій пароль: ${PW3}`,
    `密码: ${PW3}`,
    `密碼：${PW3}`,
    `비밀번호는 ${PW3} 입니다`,
    `كلمة المرور الخاصة بي هي ${PW3}`,
    `mật khẩu của tôi là ${PW3}`,
    `kata sandi saya ${PW3}`,
    `mitt lösenord är ${PW3}`,
    `passordet mitt er ${PW3}`,
    `ο κωδικός μου είναι ${PW3}`,
    `moje heslo je ${PW3}`,
    `parola mea este ${PW3}`,
    `identifiant: pquinn / mdp: ${PW3}`,
    `Kennwort: ${PW3}`,
    `ang password ko ay ${PW3}`,
    `salasanani on ${PW3}`,
    `הסיסמה שלי היא ${PW3}`,
    `मेरा पासवर्ड ${PW3} है`,
    `la contrasenya és ${PW3}`,
    `a senha do wifi é ${PW3}`,
  ]) {
    expectGone(text, PW3);
    assert.ok(found(text).length, text);
  }
  assert.deepEqual(found("şifrem 482915"), ["482915"]);
  for (const quiet of [
    "esqueci minha senha, pode me ajudar?",
    "a senha deve ter 8-16 caracteres",
    "senha e usuário estão corretos",
    "la password è sbagliata",
    "la parola è bella",
    "mijn wachtwoord is verlopen",
    "nie pamiętam hasła",
    "şifremi unuttum",
    "я забыл пароль от почты",
    "пароль должен содержать 8 символов",
    "пароль 2 раза ввёл",
    "我忘记了密码",
    "密码是什么？",
    "密码是8-16位",
    "パスワードを忘れました",
    "パスワードは8文字以上です",
    "비밀번호를 잊어버렸어요",
    "비밀번호는 8자 이상",
    "mật khẩu của tôi là gì?",
    "kata sandi saya salah",
    "kata sandi 8 karakter",
    "jag har glömt mitt lösenord",
    "heslo je příliš krátké",
    "parola mea este greșită",
    "Passwort: ändern Sie es bitte",
    "The MDP is a 5-tuple (S, A, P, R, γ)",
    "MDP: s1 -> s2",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a password column in a CSV or tab-separated paste is covered", () => {
  assert.equal(
    cover(`username,password,role\npquinn,${PW2},admin\njlee,Hunter2-Quinn!88,user`),
    `username,password,role\npquinn,${HIDDEN},admin\njlee,${HIDDEN},user`,
  );
  for (const [text, secret] of [
    [`name,url,username,password,note\nexample.com,https://example.com/login,pquinn,${PW},`, PW],
    [`Benutzer;Passwort;Rolle\npquinn;${PW2};admin`, PW2],
    [`user\tpassword\tteam\npquinn\t${PW3}\tops`, PW3],
    ['"user","password"\n"pquinn","Blue,Sky42x!"', "Blue,Sky42x!"],
    [
      `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Mail,,,0,https://mail.example.com,pquinn,${PW3},`,
      PW3,
    ],
  ]) {
    expectGone(text, secret);
  }
  for (const quiet of [
    "user,password_changed,role\npquinn,yes,admin",
    "name,has_password\nbob,true",
    "id,password\n1,\n2,",
    "user,password\nbob,********",
    "step,password,notes\nfirst,see the vault,ask IT",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a password in a pasted shell command is covered", () => {
  for (const [text, secret] of [
    [`PGPASSWORD=${PW2} psql -h db.internal -U app orders`, PW2],
    [`export SSHPASS='${PW2}'`, PW2],
    [`sshpass -p '${PW2}' ssh admin@example.dev`, PW2],
    ["sshpass -p Vq7mLp2xRz ssh admin@example.dev", "Vq7mLp2xRz"],
    [`curl -u admin:${PW2} https://jenkins.example.dev/api/json`, PW2],
    [`curl --user "deploy:${PW2}" https://repo.example.dev/upload`, PW2],
    [`curl -s \\\n  -u admin:${PW2} \\\n  https://jenkins.example.dev/api/json`, PW2],
    [`docker login -u pquinn -p ${PW2} registry.example.com`, PW2],
    [`az login -u pquinn@example.dev -p ${PW2}`, PW2],
    [`helm registry login registry.example.com --username pquinn -p '${PW2}'`, PW2],
    [`mongosh "mongodb://db.internal" -u admin -p ${PW2}`, PW2],
    [`redis-cli -h cache.internal -a ${PW2}`, PW2],
    [`keytool -importcert -alias ca -file ca.crt -keystore truststore.jks -storepass ${PW2}`, PW2],
    [`net use Z: \\\\files\\share /user:QUINN\\pquinn ${PW2}`, PW2],
    [`aws configure set aws_secret_access_key ${AWS_SECRET}`, AWS_SECRET],
  ]) {
    expectGone(text, secret);
    assert.ok(found(text).length, text);
  }
  for (const quiet of [
    "docker run -p 8080:80 nginx",
    "docker login -u pquinn --password-stdin < token.txt",
    'curl -u "$USER:$PASS" https://example.dev',
    "curl -u admin: https://example.dev",
    "curl -u ${API_USER}:${API_TOKEN} https://example.dev",
    "sshpass -f ~/.pw ssh db.example.dev",
    "sshpass -e ssh db.example.dev",
    "redis-cli -a $REDIS_PASSWORD",
    "kubectl logs -p mypod",
    "net use Z: \\\\files\\share /user:QUINN\\pquinn *",
    "mongosh -u admin -p",
    "keytool -list -keystore x.jks -storepass:env STOREPASS",
    "aws configure set region us-east-1",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a secret set in code, a config file or SQL is covered", () => {
  assert.equal(cover(`define('DB_PASSWORD', '${PW2}');`), `define('DB_PASSWORD', '${HIDDEN}');`);
  for (const [text, secret] of [
    [
      "define( 'AUTH_KEY', 'q7Vb2Rk9LmT4xWz8Np3H" + "s6Jd1Fc5Gy0Ua7Ee2Io9' );",
      "q7Vb2Rk9LmT4xWz8Np3H" + "s6Jd1Fc5Gy0Ua7Ee2Io9",
    ],
    [`os.environ.setdefault("DB_PASSWORD", "${PW2}")`, PW2],
    [`os.environ["DB_PASSWORD"] = "${PW2}"`, PW2],
    [`Environment.SetEnvironmentVariable("API_KEY", "${HEX32}")`, HEX32],
    ['localStorage.setItem("token", "q7Vb2Rk9LmT4xWz8Np3Hs6Jd")', "q7Vb2Rk9LmT4xWz8Np3Hs6Jd"],
    [`variable "db_password" {\n  type    = string\n  default = "${PW2}"\n}`, PW2],
    [`export const apiKey: string = "${HEX32}";`, HEX32],
    [`API_KEY: str = "${HEX32}"`, HEX32],
    [`private password: string = "${PW2}";`, PW2],
    [`r = requests.get(url, auth=("pquinn", "${PW2}"))`, PW2],
    [`HTTPBasicAuth("pquinn", "${PW2}")`, PW2],
    [`CREATE USER 'report'@'%' IDENTIFIED BY '${PW2}';`, PW2],
    [`ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${PW2}';`, PW2],
    [`<appSettings>\n  <add key="ApiKey" value="${HEX32}" />\n</appSettings>`, HEX32],
    [`<add key="DbPassword" value="${PW2}" />`, PW2],
    [`<input type="hidden" name="api_key" value="${HEX32}">`, HEX32],
    [`database:\n  user: app\n  password: >-\n    ${PW2}\n  host: db.internal`, PW2],
    [`password: |\n  ${PW2}`, PW2],
  ]) {
    expectGone(text, secret);
    assert.ok(found(text).length, text);
  }
  for (const quiet of [
    "define('WP_DEBUG', true);",
    "define('DB_PASSWORD', getenv('DB_PASSWORD'));",
    "define('DB_PASSWORD', '');",
    'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")',
    'localStorage.setItem("theme", "dark")',
    'localStorage.setItem("token", token)',
    'variable "db_password" {\n  type      = string\n  sensitive = true\n}',
    "export const apiKey: string = process.env.API_KEY!;",
    "password: string;",
    'auth=("pquinn", password)',
    "CREATE USER 'report'@'%' IDENTIFIED BY '';",
    '<add key="ApiBaseUrl" value="https://api.example.com" />',
    '<add key="ApiKey" value="" />',
    '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">',
    "password: |\n  # set in the vault",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a bearer token in a Python f-string, an nginx line or a header assignment is covered", () => {
  const token = "pmgnkfDQgAIXJ8WxAe4d" + "kIrqPZnvllWlUyn5Ku7D";
  for (const text of [
    `headers = {"Authorization": f"Bearer ${token}"}`,
    `proxy_set_header Authorization "Bearer ${token}";`,
    `headers["Authorization"] = "Bearer ${token}"`,
  ]) {
    expectGone(text, token);
  }
  for (const quiet of [
    'headers = {"Authorization": f"Bearer {token}"}',
    "proxy_set_header Authorization $http_authorization;",
    'proxy_set_header Authorization "Bearer $token";',
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a labeled token longer than 128 characters is covered", () => {
  const alphabet = "q7Vb2Rk9LmT4xWz8Np3Hs6Jd/1Fc5Gy0U+a7Ee2Io9";
  const body = (n) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + (i >> 3)) % alphabet.length]).join("");
  const session = body(356) + "==";
  const bearer = "ya29.a0" + body(210).replace(/[+/]/g, "_");
  const fcm = "AAAAnU5CXsF:APA91b" + body(134).replace(/[+/]/g, "-");
  const twitter =
    "A".repeat(21) + "KoMAI7oiECHxBdmTsE8JKtUFjhn9VU%3Dl795Z5yTkwicStz8NyaDIzcdC4dnVEydWKngVKqHlMfs6g90Km";
  for (const [text, secret] of [
    [
      `aws_access_key_id = ASIA4HPQ7XZ2R6TWLJ3N\naws_secret_access_key = ${AWS_SECRET}\naws_session_token = ${session}`,
      session,
    ],
    [`Authorization: Bearer ${bearer}`, bearer],
    [`here's my firebase server key: ${fcm}`, fcm],
    [`TWITTER_BEARER_TOKEN=${twitter}`, twitter],
  ]) {
    expectGone(text, secret);
  }
  for (const quiet of [
    `docs_url: https://example.com/${"guides/".repeat(30)}start`,
    `token: ${"A".repeat(200)}`,
    `TWITTER_BEARER_TOKEN=${"A".repeat(120)}`,
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("Tailscale, Fly, NuGet and crates.io tokens, and a DeepSeek key after its label, are covered", () => {
  // DeepSeek doesn't document its keys' shape past "sk-", so one needs a label, and on its own it stays quiet.
  const deepseek = "sk-" + "daee6a6adfbd087ac68bcae94aa91573";
  for (const text of [
    `getting a 401 from the api, here's my deepseek key: ${deepseek} — what am I doing wrong?`,
    `DEEPSEEK_API_KEY=${deepseek}`,
    `deepseek token: ${deepseek}`,
  ]) {
    expectGone(text, deepseek);
  }
  assert.deepEqual(found(deepseek), []);
  const tokens = [
    "tskey-auth-" + "k5lvGb664mRCNTRL-l88QJKkTxT3ppQ2k3r3R4dT6yddVaDX9",
    "FlyV1 fm2_" +
      "ageahJ6Q9O7is2gbsoCwGCOxqG3SXk5HvKsySKv4XlyzSnC+N5o3D9Be5k5d3o2mmj2sRlAwdkcZZD/pcAUAqgJcVCPJdvGcixyRks",
    "oy2" + "0aes77opmruzpcq2l4c06dm6ydnommk8xw432ec44hv",
    "cio" + "rbVF3Vglz7p9W8X68r853I7ea48Y1GyD",
  ];
  for (const token of tokens) {
    for (const text of [token, `here's the token: ${token}`, `FLY_API_TOKEN="${token}"`]) {
      expectGone(text, token);
      assert.ok(found(text).length, text);
    }
  }
  assert.equal(cover(tokens[0]), "[REDACTED SERVICE ACCESS TOKEN]");
  for (const quiet of [
    "deepseek key: sk-" + "12345678901234567890123456789012",
    "tskey-auth-XXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXX",
    "the ciocolata recipe calls for cocoa",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

// A Fly.io token is base64 of binary fields, and the zero bytes in them read as runs of A's, as near the start of a
// real one. Six of a character in a row means a made-up value elsewhere, so these were let go whole.
test("a Fly.io token with the runs of A's real ones have is covered whole, bare or after its label", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 7;
  let rest = "";
  for (let i = 0; i < 300; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    rest += alphabet[(seed >>> 16) % 64];
  }
  const token = "FlyV1 " + "fm2_" + "lJPECAAAAAAAAMqx" + rest.slice(0, 150) + "AAAAAAAAAAAA" + rest.slice(150);
  for (const text of [token, `FLY_API_TOKEN=${token}`, `fly token: ${token}`, `here's the deploy token ${token}`]) {
    expectGone(text, token.slice(6));
  }
  // A made-up one still stays quiet.
  assert.deepEqual(found("FlyV1 " + "fm2_" + "A".repeat(60)), []);
});

test("a wallet's private key told in a sentence, a WireGuard key and an age key are covered", () => {
  const eth = "0x" + "90571f9fb0e8346b227e57ad27af96a3aa6cb1361dc2863c4d80574904c5b83a";
  const wif = "5K6oy7gCdM4xj9WTapbTtbBZWx9Nggg8pbny53FrtB3Ngiwom4p";
  const wg = "BZsCgzRW5vhY+ML1gl1Q5b4XoWaFhwAC9LuToLMTpgW=";
  const age = "AGE-SECRET-KEY-1" + "WLGHWF4RHDN9AY9V040EPFVXJVU8F7CPQ7XN8H7HCPM7TPG0GSE5HFFWHE";
  for (const [text, secret] of [
    [`my metamask private key is ${eth} can I import it into ledger`, eth.slice(2)],
    [`importprivkey ${wif} "savings"`, wif],
    [`[Interface]\nPrivateKey = ${wg}\nAddress = 10.8.0.2/24`, wg],
    [`[Peer]\nPresharedKey = ${wg}`, wg],
    [`# public key: age1qyqszqgpqyqszqgpqyqszqgp\n${age}`, age],
  ]) {
    expectGone(text, secret);
  }
  for (const quiet of [
    "the private key is stored in a hardware wallet",
    `[Peer]\nPublicKey = ${wg}`,
    "the tx hash is 0x90571f9fb0e8346b227e57ad27af96a3aa6cb1361dc2863c4d80574904c5b83a",
    "AGE-SECRET-KEY-1",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a sign-in code told before who sent it is covered", () => {
  for (const text of [
    "When you sign in, enter the code 482915 we texted you.",
    "Type the verification code 482915 they sent you by text",
  ]) {
    expectGone(text, "482915");
    assert.ok(found(text).length, text);
  }
  for (const quiet of [
    "enter the code 4821 they gave you for the gate",
    "use the discount code 4821 we sent you",
    "enter the code 2024 we texted",
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a Twilio secret on its own line is covered without its account SID beside it", () => {
  const token = "9f2c4e6a8b0d1f3e5a7c9b2d4f6e8a0c";
  const apiSecret = "Vq7mLp2xRzK9wQ4tN8bF3hJ6sD1gY5cA";
  for (const [text, secret] of [
    [`TWILIO_AUTH_TOKEN=${token}`, token],
    [`export TWILIO_AUTH_TOKEN="${token}"`, token],
    [`TWILIO_API_SECRET=${apiSecret}`, apiSecret],
  ]) {
    expectGone(text, secret);
  }
  const pair = `TWILIO_ACCOUNT_SID=AC7a29931d` + `9870697868b962e3631e7a18\nTWILIO_AUTH_TOKEN=${token}`;
  assert.deepEqual(
    globalThis.Clotr.detect(pair).map((r) => r.id),
    ["twilio_credentials"],
  );
  assert.deepEqual(found("TWILIO_ACCOUNT_SID=AC7a29931d" + "9870697868b962e3631e7a18"), []);
});

// The label finders skipped a value found anywhere inside a SID and token pair, so a second copy of the token under
// its own label was left whole, while Cover it hid only the pair it belonged to.
test("a Twilio token written again away from its account SID is covered there too", () => {
  const sid = "AC7a29931d" + "9870697868b962e3631e7a18";
  const token = "9f2c4e6a8b0d1f3e5a7c9b2d4f6e8a0c";
  const mixed = "Vq7mLp2xRzK9wQ4tN8bF3hJ6sD1gY5cA";
  for (const [text, secret] of [
    [`TWILIO_ACCOUNT_SID=${sid}\nTWILIO_AUTH_TOKEN=${token}\n\nand in prod: TWILIO_AUTH_TOKEN=${token}`, token],
    [`TWILIO_ACCOUNT_SID=${sid}\nTWILIO_AUTH_TOKEN=${token}\n\nprod: auth_token: ${token}`, token],
    [`accountSid: "${sid}", authToken: "${mixed}"\nlater the token alone: password=${mixed}`, mixed],
  ]) {
    expectGone(text, secret);
  }
  const pair = `TWILIO_ACCOUNT_SID=${sid}\nTWILIO_AUTH_TOKEN=${token}`;
  assert.deepEqual(
    globalThis.Clotr.detect(`${pair}\n\n${pair}`).map((r) => r.id),
    ["twilio_credentials"],
  );
});

test("a public key's label doesn't make a hex value or the next line a secret", () => {
  const hex = "7a29931d9870697868b962e3631e7a18";
  const pub = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq";
  const sec = "AGE-SECRET-KEY-1WLGHWF4RHDN9AY9V040EPFVXJVU8F7CPQ7XN8H7HCPM7TPG0GSE5HFFWHE";
  const keyFile = `# created: 2026-10-01\n# public key: ${pub}\n${sec}`;
  assert.deepEqual(
    globalThis.Clotr.detect(keyFile).map((r) => [r.id, r.matches]),
    [["private_key", [sec]]],
  );
  for (const quiet of [
    `PUBLIC_KEY=${hex}`,
    `define('PUBLIC_KEY', '${hex}');`,
    `os.environ["PUBLIC_KEY"] = "${hex}"`,
    `publishable_key: ${hex}`,
  ]) {
    assert.deepEqual(found(quiet), [], quiet);
  }
});

test("a password column read back from a rich editor, with a blank line between rows, is covered", () => {
  const csv = `username,password,role\n\npquinn,${PW2},admin\n\njlee,Hunter2-Quinn!88,user`;
  expectGone(csv, PW2);
  expectGone(csv, "Hunter2-Quinn!88");
  assert.deepEqual(found("name,password\n\nsee the attached sheet, it has a,b"), []);
});
