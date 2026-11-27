"use strict";

// Developer text that isn't a secret or a personal detail: doc placeholders and elided keys, hashes, digests, UUIDs,
// build and version numbers, git output, fingerprints and log numbers. Each quiet case sits next to the real thing in
// the same shape, which still has to be found. All values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");

const { COUNTED, meter, assertCounted } = require("./work-child.js");
const work = meter(); // before the engine, so the meter counts its steps
require("./load-engine.js")("rules", "detect");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

function expectQuiet(text) {
  assert.deepEqual(detect(text), {}, JSON.stringify(text));
}

function expectKind(text, kind, value) {
  const found = detect(text);
  assert.ok(found[kind], `${JSON.stringify(text)}: no ${kind} finding → ${JSON.stringify(found)}`);
  if (value !== undefined) {
    assert.ok(found[kind].includes(value), `${JSON.stringify(text)}: ${kind} is ${JSON.stringify(found[kind])}`);
  }
}

// Hex made from a seed, so every value is different and none is typed whole.
function hexOf(seed, length) {
  let out = "";
  let x = seed >>> 0 || 1;
  while (out.length < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

const sk = "s" + "k";
const gh = "gh" + "p_";

test("a doc's placeholder or elided key after a key's label stays quiet", () => {
  for (const text of [
    `export STRIPE_SECRET_KEY="${sk}_test_..."`,
    `STRIPE_SECRET_KEY=${sk}_live_…`,
    `OPENAI_API_KEY=${sk}-...\nexport MODEL=gpt-4o`,
    `client = Anthropic(api_key="${sk}-ant-...")`,
    `token: ${gh}abc...xyz`,
    "password = pypi-AgEIcHlwaS5vcmc...",
    "OPENAI_API_KEY=your-openai-api-key",
    "OPENAI_API_KEY=your_openai_key_here",
    "ANTHROPIC_API_KEY=your-anthropic-key-here",
    "Authorization: Bearer YOUR_ACCESS_TOKEN",
    "password: your-password-here",
    "password: YOUR_PASSWORD_HERE",
    "JWT_SECRET=your-jwt-secret",
    "api_key: xxxx-xxxx-xxxx-xxxx",
    `"apiKey": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"`,
    "SECRET_KEY = 'django-insecure-change-me'",
    "API_KEY=fake-api-key-for-tests",
    "TOKEN=test-token",
    "SECRET=test_secret_123",
    `api_key = "sample_key_abc123XYZ"`,
    "const apiKey = 'mock-api-key-12345';",
    "APP_KEY=base64:your-app-key-here",
    "data:\n  api-key: BASE64_ENCODED_KEY",
    "redis://:yourpassword@localhost:6379/0",
  ]) {
    expectQuiet(text);
  }
});

test("a real value in the same places is still found", () => {
  expectKind("password: Hunter2abc!", "password", "Hunter2abc!");
  // Dots that end a sentence aren't an elided key.
  expectKind("my password is Summer2024...", "password", "Summer2024");
  expectKind("password: pass-word2024...", "password", "pass-word2024");
  expectKind("password: Mockingbird#1", "password", "Mockingbird#1");
  expectKind("password: changeme123", "password", "changeme123");
  expectKind("password: change_me_2024", "password", "change_me_2024");
  expectKind(`api_key = "test_9fK2LmQ8xZ7pR4vT1wY6"`, "service_token", "test_9fK2LmQ8xZ7pR4vT1wY6");
  const stripe = `${sk}_live_` + "51Hx9QkLmZ2vR8tY4wP7nB3cD6fG0jK5sA1eU";
  expectKind(`STRIPE_SECRET_KEY=${stripe}`, "stripe_secret_key", stripe);
  const github = gh + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi";
  expectKind(`token: ${github}`, "github_token", github);
  expectKind("postgres://postgres:S3cr3t!x@localhost:5432/app", "connection_string");
});

// Only a provider's prefix makes the dots an elided key; a person's word-dash-word password trailing off is still one.
test("a password with a dash or underscore followed by dots is still found", () => {
  for (const [text, value] of [
    ["The wifi password is Fluffy-99...", "Fluffy-99"],
    ["password: Summer_24...", "Summer_24"],
    ["PASSWORD=Hunter_22...", "Hunter_22"],
    ["login pw = Rocky_7...", "Rocky_7"],
    ["my password is Tiger-2024... don't share it", "Tiger-2024"],
    ["password: Fluffy-99…", "Fluffy-99"],
    [`"password": "Fluffy-99..."`, "Fluffy-99"],
  ]) {
    expectKind(text, "password", value);
  }
});

// A build, commit or version number is one unbroken string; a phone written with spaces or dashes, or one with a phone
// word close by, is still a phone.
test("a phone number after build, commit or rev is still found", () => {
  for (const [text, value] of [
    ["call me about the build: 415-555-0134", "415-555-0134"],
    ["Phone for the build 415 555 0134", "415 555 0134"],
    ["Call Rev 415-555-0134", "415-555-0134"],
    ["Rev 415-555-0134 is my number", "415-555-0134"],
    ["My phone for the commit: 4155550134", "4155550134"],
    ["Site manager for the build: 0412 345 678", "0412 345 678"],
  ]) {
    expectKind(text, "phone_number", value);
  }
});

// A setting's name used as a blank is letters only; a chosen password with digits in a word isn't one.
test("an all-caps password ending in _KEY, _TOKEN, _SECRET or _PASSWORD is still found", () => {
  for (const [text, value] of [
    ["password: ACME2024_KEY", "ACME2024_KEY"],
    ["pass: TIGER99_TOKEN", "TIGER99_TOKEN"],
    ["the password is HUNTER2_PASSWORD", "HUNTER2_PASSWORD"],
    ["password: SUMMER2024_SECRET", "SUMMER2024_SECRET"],
  ]) {
    expectKind(text, "password", value);
  }
  expectKind("API_KEY=MYAPP2024_SECRET", "service_token", "MYAPP2024_SECRET");
});

// "change-me" is a stand-in only when the words before it are a few plain lowercase words.
test("a real value that merely ends in changeme or replaceme is still found", () => {
  for (const [text, value] of [
    ["password: Bluebird7-changeme", "Bluebird7-changeme"],
    ["password: Xq9vL2mR8pT4.changeme", "Xq9vL2mR8pT4.changeme"],
    ["password: My-dog-Rex.replaceme", "My-dog-Rex.replaceme"],
  ]) {
    expectKind(text, "password", value);
  }
  const django = "django-insecure-a8f$k2!m9x@q7z#w3p-change-me";
  expectKind(`DJANGO_SECRET_KEY=${django}`, "service_token", django);
});

// Docs write their stand-ins in lowercase; a capitalized password built from the same words is a person's choice.
test("a capitalized password made of test or demo words is still found", () => {
  expectKind("password: Test-Pass-99", "password", "Test-Pass-99");
  expectKind("password: Test_Pwd_42", "password", "Test_Pwd_42");
});

test("a WebSocket handshake key is a nonce, not an API key", () => {
  const nonce = "B7XCy2q3/v12PfAo1akqfQ==";
  expectQuiet(`GET /chat HTTP/1.1\nUpgrade: websocket\nSec-WebSocket-Key: ${nonce}\nSec-WebSocket-Version: 13`);
  expectKind(`X-Api-Key: ${nonce}`, "service_token", nonce);
});

test("a hex public key or fingerprint under a public key's label stays quiet", () => {
  const hex64 = hexOf(7, 64);
  for (const text of [
    `PUBLIC_KEY=${hex64}`,
    `public_key: ${hexOf(8, 40).toUpperCase()}`,
    `{"publishable_key": "${hexOf(9, 64)}"}`,
    `public_key: sha256:${hexOf(10, 64)}`,
  ]) {
    expectQuiet(text);
  }
  expectKind(`SECRET_KEY=${hex64}`, "service_token", hex64);
});

test("build numbers, versions and git output aren't phone numbers", () => {
  for (const text of [
    "Build 20240130.10 succeeded",
    "Run 20241010.10",
    "Google Chrome 131.0.6778.205",
    "Microsoft Edge 120.0.2210.91 (Official build) (64-bit)",
    'versionCode 2024010100\nversionName "3.1.4"',
    `android:versionCode="2024010100"`,
    "https://github.com/acme/app/actions/runs/7002003507/job/20026496437",
    "diff --git a/src/app.js b/src/app.js\nindex 0e85c78..af00502 100644\n--- a/src/app.js",
    "To github.com:acme/app.git\n   2147a04..1355673  main -> main",
    " + 2147a04...1355673 topic -> topic (forced update)",
    "commit 7475674945",
    "Epoch 3/10 - loss: 0.8912116821 - accuracy: 0.1902",
    "Cookie: _ga=GA1.1.8912116821.1700000000",
    'http_requests_total{code="200",method="get"} 8912116821',
    "process_resident_memory_bytes 4155550134",
    "      A5B8 2ED9 5976 FEE9 EAC9  8063 C073 6090 3720 E475",
  ]) {
    expectQuiet(text);
  }
});

test("a phone number near the same words is still found", () => {
  expectKind("Build failed, call 415 555 0134", "phone_number", "415 555 0134");
  expectKind("commit to call 4155550134 tomorrow", "phone_number", "4155550134");
  expectKind("https://wa.me/14155550134", "phone_number", "14155550134");
  expectKind("my number is 4155550134", "phone_number", "4155550134");
  expectKind("2024-03-01 10:00:00 INFO callback number 415-555-0134", "phone_number", "415-555-0134");
  expectKind("release notes: call 415.555.0134", "phone_number", "415.555.0134");
  // A phone word makes a stray dot a typo, and a WHOIS record writes a phone as +1.NNNNNNNNNN.
  expectKind("phone: 0.4155550134", "phone_number", "0.4155550134");
  expectKind("Registrant Phone: +1.4155550134", "phone_number", "+1.4155550134");
  expectKind("phone_number 4155550134", "phone_number", "4155550134");
  expectKind("my fingerprint A5B8 2ED9 5976 FEE9 EAC9 and call 415 555 0134", "phone_number", "415 555 0134");
  expectKind("PPS number 6860073F", "national_id", "6860073F");
});

test("a hash, UUID or fingerprint isn't a national ID or a bank routing number", () => {
  for (const text of [
    "MD5: D9D770BCA9ADB38E88728063CC849338",
    "MD5: 0C4C8CF172181E753AE9CC2896181222",
    "checksum 1B94E157EEC6EC1632A7E82E6472D263CC318189",
    "2E4B 5CAA F30D 800A 8394 ABBD 7772 6860 073F C904",
    "id 55e4af5b-f438-4be6-aba8-42258489f948",
    "{55E4AF5B-F438-4BE6-ABA8-42258489F948}",
  ]) {
    expectQuiet(text);
  }
  expectKind("cédula CC 1234567890", "national_id", "1234567890");
  expectKind("routing number 021000021", "bank_account", "021000021");
  expectKind("ABA 021000021", "bank_account", "021000021");
});

test("an uppercase SHA-256 isn't a Square token", () => {
  const hash = "EAAA" + hexOf(11, 60).toUpperCase();
  expectQuiet(`SHA256: ${hash}`);
  expectQuiet(`Algorithm       Hash\n---------       ----\nSHA256          ${hash}       C:\\setup.zip`);
  const square = "EAAA" + "Ek9mZ2xQ7rT4wY1uI8oP3aS6dF0gH5jK2lZ9xC4vB7nM1qW8eR3tY6uI0oP5";
  expectKind(`here it is: ${square}`, "service_token", square);
});

test("a private key block with no key in it stays quiet, and a header or a real body still warns", () => {
  // The markers are built from pieces so no whole block sits in the source.
  const dashes = "-".repeat(5);
  const marker = (edge, type = "") => `${dashes}${edge} ${type}PRIVATE ${"KEY"}${dashes}`;
  const block = (type, body) => `${marker("BEGIN", type)}\n${body}\n${marker("END", type)}`;
  expectQuiet(block("", "..."));
  expectQuiet(block("RSA ", "<your private key here>"));
  expectQuiet(`PRIVATE_KEY="${marker("BEGIN")}\\n...\\n${marker("END")}\\n"`);
  expectKind(marker("BEGIN", "RSA "), "private_key");
  const key = block("RSA ", "MIIEowIBAAKCAQEA0YpABC123+/=\nanotherLineOf" + "SecretBase64==");
  expectKind(key, "private_key", key);
});

test("a local database's default login is quiet, and the same login on a real host is not", () => {
  for (const text of [
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/test",
    "AMQP_URL=amqp://guest:guest@localhost:5672/",
    "mysql://root:root@127.0.0.1:3306/app",
  ]) {
    expectQuiet(text);
  }
  expectKind("postgres://admin:admin@db.internal:5432/x", "connection_string");
  expectKind("postgres://app:app@10.0.0.5:5432/x", "connection_string");
});

// jwt.io's sample token is in every tutorial, but secret scanners' own test cases use it as the token to find, and
// a token is signed with whatever key its service uses, so it is still reported.
test("jwt.io's sample token and another token are both found", () => {
  const sample =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  expectKind(`const token = "${sample}";`, "jwt", sample);
  const other =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiJ1c3ItODgxMiIsInJvbGUiOiJhZG1pbiIsImV4cCI6MTc5MDAwMDAwMH0" +
    ".Qm9vX2xLc3Z4dFp3WmRkY3lSbE5vTjJKcWV2Rk1Y";
  expectKind(`Authorization: Bearer ${other}`, "jwt", other);
});

test("a git host's no-reply address is quiet, and a real address is not", () => {
  expectQuiet("Author: Sam Lee <sam@users.noreply.github.com>");
  expectQuiet("Signed-off-by: Priya <1234567+priya@users.noreply.github.com>");
  expectQuiet("Author: Kim <kim@users.noreply.gitlab.com>");
  expectKind("Author: Sam Lee <sam.lee@acme-mail.com>", "email", "sam.lee@acme-mail.com");
  expectKind("sam@users.noreply.example.com", "email");
});

// Each reader is timed on its own, on the whole input: detect() reads a long paste in windows, which would hide a
// reader that slows down on one long run.
test("the new developer-text readers stay linear on hostile text", () => {
  const find = (id) => globalThis.Clotr.PATTERNS.find((p) => p.id === id).find;
  const repeat = (unit) => (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases = [
    ["phone_number", repeat("A5B8 ")],
    ["phone_number", repeat("A5B8 4155550134 ")],
    ["national_id", repeat("2E4B 6860 073F ")],
    ["phone_number", repeat("abcdef1..")],
    ["phone_number", (n) => "0e85c78.." + "a".repeat(n)],
    ["phone_number", repeat("0.1234567")],
    ["phone_number", (n) => "1." + "2".repeat(n) + "."],
    ["phone_number", (n) => "x" + "_a".repeat(n / 2) + " 4155550134"],
    ["phone_number", repeat('m_total{a="b"} 4155550134\n')],
    ["phone_number", (n) => "GA1.1." + "1".repeat(n)],
    ["phone_number", repeat("/runs/4155550134 build 4155550134 ")],
    ["password", repeat("password: your_")],
    ["password", repeat("password: sk-a-b-...")],
    ["password", repeat("secret=test_key_ ")],
    ["password", repeat("password: a-b.c_changeme ")],
    ["password", repeat("password: AB_BASE64_")],
    ["service_token", repeat("public_key: ")],
    ["service_token", repeat("EAAA")],
    ["private_key", repeat("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n")],
    ["private_key", (n) => "-----BEGIN PRIVATE KEY-----\n" + "A.".repeat(n / 2) + "\n-----END PRIVATE KEY-----"],
    ["connection_string", repeat("postgres://a:a@localhost ")],
    ["email", repeat("a@users.noreply.github.com ")],
    ["bank_account", repeat("aba8-42258489 ")],
    ["bank_account", repeat("ABA021000021 RTN")],
    ["phone_number", repeat("4155550134..")],
    ["phone_number", (n) => "1234567.." + "1".repeat(n)],
    ["phone_number", repeat("1.4155550134 ")],
    ["phone_number", (n) => "1." + "1".repeat(n)],
    ["phone_number", repeat('contact_tel_info{a="cell"} 4155550134\n')],
    ["phone_number", (n) => "x_info{" + "tel ".repeat(n / 4)],
    ["phone_number", repeat("number contact build 4155550134 ")],
    ["password", repeat("passphrase: tango xxx lima ")],
  ];
  for (const [id, make] of cases) {
    if (work) {
      work.assertWorkLinear(find(id), (_id, n) => make(n), [id], 75 * 1024, undefined, [__filename]);
      continue;
    }
    const small = make(75 * 1024);
    const big = make(300 * 1024);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => find(id)(small),
          () => find(id)(big),
        ),
      (s, b) => grewMoreThan(s, b, 10),
    );
    assert.ok(!slow, `${id} on ${JSON.stringify(small.slice(0, 30))}: time grew too much for 4× the input`);
  }
});

// Several of these readers are regexes that could backtrack inside one run, which only the clock sees, so the clock
// check stays and the same cases run counted too (CLOTR_WORK=1), which sees a pass or a loop too many.
test("the new developer-text readers also make linear work, counted", { skip: COUNTED }, () => {
  assertCounted(__filename, ["the new developer-text readers stay linear on hostile text"]);
});

// Only the handshake's own header names a nonce; a setting or a label named for a websocket can hold the real key.
test("a websocket setting's key is still found, and the handshake header stays quiet", () => {
  const value = "Zk3pQ9vL2mR8" + "xT4wY7nB6cD1";
  expectKind(`WEBSOCKET_KEY=${value}`, "service_token", value);
  expectKind(`websocket_key: "${value}aa"`, "service_token", `${value}aa`);
  expectKind(`PUSHER websocket key: a${value.slice(0, 20)}`, "service_token", `a${value.slice(0, 20)}`);
  expectQuiet("Sec-WebSocket-Key: B7XCy2q3/v12PfAo1akqfQ==");
  expectQuiet("sec_websocket_key=B7XCy2q3/v12PfAo1akqfQ==");
});

// A git range always has a hex letter in it somewhere; two plain numbers joined by dots can be two phones.
test("phones joined by two or three dots are still found, and a git range stays quiet", () => {
  expectKind("Call 4155550134..4155550135", "phone_number", "4155550134");
  expectKind("Call 4155550134..4155550135", "phone_number", "4155550135");
  expectKind("My numbers are 4155550134...4155550199", "phone_number", "4155550134");
  expectKind("My numbers are 4155550134...4155550199", "phone_number", "4155550199");
  for (const text of ["2147a04..1355673", "index 0e85c78..af00502 100644", "1234567..abcdef0", "abcdef0...1234567"]) {
    expectQuiet(text);
  }
});

// "rtn" is never hex, and a UUID group is "aba", one hex digit and a dash, so a label glued to its number still counts.
test("a routing label glued to its number is still found, and a UUID's aba group stays quiet", () => {
  expectKind("ABA021000021", "bank_account", "021000021");
  expectKind("RTN021000021", "bank_account", "021000021");
  expectKind("rtn: 021000021", "bank_account", "021000021");
  expectQuiet("3f2b1c9e-4be6-aba8-4225-8489abcd1234");
  expectQuiet("3f2b1c9e-4be6-aba8-42258489abcd");
  expectQuiet("{55E4AF5B-F438-4BE6-ABAF-42258489F948}");
});

// A metric named for a phone or a contact holds one; a metric that merely starts with "tel" (telemetry) doesn't.
test("a phone on a metric-shaped line named for a phone is still found", () => {
  expectKind("emergency_contact_info 4155550134", "phone_number", "4155550134");
  expectKind('phone_number{type="cell"} 4155550134', "phone_number", "4155550134");
  expectKind("Mobile_info 4155550134", "phone_number", "4155550134");
  expectKind("sms_sender_info 4155550134", "phone_number", "4155550134");
  for (const text of [
    "telemetry_events_total 4155550134",
    "cellular_bytes_total 4155550134",
    'http_requests_total{method="post"} 1027 1395066363000',
    'telephony_calls_total{code="200"} 8912116821',
  ]) {
    expectQuiet(text);
  }
});

// Country code 1 and ten digits is a North American phone in a WHOIS record's form, with or without its plus, so a
// long decimal of that shape is never quieted. (Recall over quiet: "lr: 1.2345678901" warns again, as it did before.)
test("a North American phone written as 1. and ten digits is still found", () => {
  for (const text of ["contact: 1.4155550134", "reach me on 1.4155550134", "My number: 1.4155550134"]) {
    expectKind(text, "phone_number", "1.4155550134");
  }
  expectQuiet("loss: 1.41555501345");
  expectQuiet("Epoch 3/10 - loss: 0.8912116821");
  // Recall over quiet: "contact" or "number" close by can mean a phone typed with a stray dot, so these warn, as they
  // did before measurements were quieted.
  expectKind("Contact loss: 0.8912116821", "phone_number", "8912116821");
  expectKind("Best number so far: 0.8912116821", "phone_number", "8912116821");
});

// "contact", "number", "reach" and "sms" name a phone as surely as "call" does, so a build or version word nearby,
// or a long decimal after them, doesn't make the phone a build number or a measurement.
test("a phone after contact, number, reach or sms is still found next to build words and as a long decimal", () => {
  for (const text of [
    "Contact for the build: 4155550134",
    "Emergency contact, build 4155550134",
    "reach me after the commit: 4155550134",
    "my number for the build: 4155550134",
    "SMS build 4155550134",
  ]) {
    expectKind(text, "phone_number", "4155550134");
  }
  for (const text of ["my number is 0.4155550134", "contact: 0.4155550134", "sms: 0.4155550134"]) {
    expectKind(text, "phone_number", "4155550134");
  }
  for (const text of ["versionCode 2024010100", "version number 2024010100", "commit 7475674945"]) {
    expectQuiet(text);
  }
  expectQuiet("Epoch 3/10 - loss: 0.8912116821 - accuracy: 0.1902");
});

// Only a mask that is all X's stands in for a key; one X word inside a passphrase is part of it.
test("a passphrase with one word of x's in it is found whole", () => {
  expectKind("my passphrase is tango xxx lima delta", "password", "tango xxx lima delta");
  expectQuiet("api_key: xxxx-xxxx-xxxx-xxxx");
  expectQuiet("password: xxxx-xxxx-xxxx");
});

// A numbered list typed without a space after the dot ("1.4155550134, 2.6505550199") is a list of phones, not long
// decimals, however far the list runs past its heading.
test("phones in a numbered list with no space after the dot are all found", () => {
  const cases = [
    ["Phones: 1.4155550134, 2.6505550199, 3.2125550147", ["6505550199", "2125550147"]],
    ["Numbers:\n1.4155550134\n2.6505550199", ["6505550199"]],
    ["Contacts:\n1.4155550134\n2.6505550199", ["6505550199"]],
    ["Telefonos\n1.5512345678\n2.5598765432", ["5598765432"]],
    ["Ring these:\n1.4155550134\n2.6505550199\n3.2125550147\n4.3105550111\n5.7185550123", ["3105550111", "7185550123"]],
  ];
  for (const [text, phones] of cases) for (const phone of phones) expectKind(text, "phone_number", phone);
  expectQuiet("loss: 0.8912116821");
  expectQuiet("loss: 2.3025850930");
  expectQuiet("pi 2.3025850930");
});
