// Detection tests. Run from the repo root:  node --test tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { retrySlow, bestOfBoth, bestOfPair, grewMoreThan, reference, REFERENCE_MS } = require("./timing.js");

// The extension's own detect(), reshaped to { patternId: [matched text, …] }
function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

test("a speed check measures again after a slow moment, and still fails real slowness", () => {
  let n = 0;
  assert.equal(
    retrySlow(() => (++n === 1 ? "slow moment" : undefined), { pauseMs: 1 }),
    2,
  );
  assert.throws(() => retrySlow(() => "always slow", { pauseMs: 1 }), /always slow \(slow on all 3 tries\)/);
});

test("a budget check counts this process's own work: waiting on a busy computer isn't over budget, real work is", () => {
  // Waiting (another program on the processor) shows on the clock but not in this process's processor time.
  const waited = bestOfBoth(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120), 1);
  assert.ok(waited.wall >= 100 && !waited.over(100), `clock ${waited.wall} ms, processor ${waited.cpu} ms`);
  // Real work shows on both the clock and the processor. Three times the reference work always goes over a
  // one-reference budget, quiet computer or busy, because a busy computer slows the reference by the same amount.
  const worked = bestOfBoth(() => [reference(), reference(), reference()], 1);
  assert.ok(
    worked.over(REFERENCE_MS),
    `clock ${worked.wall} ms, processor ${worked.cpu} ms, ${worked.allowed} allowed on this computer now`,
  );
});

// These speed checks still catch real regressions. Code I plant to be slow fails them whether the computer is
// quiet or every core is busy (npm run test:load runs the tests under load), and the same work done without the
// slowness passes. Both kinds of slowness happened here before.
test("the speed checks still fail slow code: a quadratic function and a backtracking pattern", () => {
  const repeat = (u, n) => u.repeat(n);
  // This repeats the old two-step sign-in key reader's mistake: each find makes its own pass over the whole text,
  // so 4 times the text takes 16 times as long. That version took 19 seconds on 20,000 links.
  const quadratic = (text) => {
    let n = 0;
    for (const m of text.matchAll(/\d+/g)) n += text.replace(/\d/g, "#").length & m.index;
    return n;
  };
  // A miss names the growth (4 times the text in 16 times the time) or, on a slower computer, the budget.
  const missed = /(for 4× the input|repeats) \(slow on all 3 tries\)/;
  assert.throws(() => assertLinear(quadratic, repeat, ["7 Oak Dr. "], 700), missed);
  // This repeats the old email pattern's mistake too: without an @, it tries every start position and runs to the
  // end of the text from each one. That version took about 3 seconds on 20,000 characters of "a-a-a-…".
  const email = /[\w.-]+@[\w-]+\.\w+/;
  assert.throws(() => assertLinear((text) => email.test(text), repeat, ["a-"], 2800), missed);
  // This text makes the quadratic code take about three times what the budget allows.
  const text = "7 Oak Dr. ".repeat(2000);
  const slow = bestOfBoth(() => quadratic(text));
  assert.ok(slow.over(25), `${slow.wall.toFixed(0)} ms, ${slow.allowed.toFixed(0)} allowed on this computer now`);
  // The same kind of work passes when its time grows with the text: 400 passes over it, so 4 times the text takes
  // about 4 times as long.
  const linear = (t) => {
    let n = 0;
    for (let pass = 0; pass < 400; pass++) n += t.replace(/\d/g, "#").length;
    return n;
  };
  assertLinear(linear, repeat, ["7 Oak Dr. "], 2000);
});

function expectNone(text) {
  const found = detect(text);
  assert.deepEqual(found, {}, `"${text}" → ${JSON.stringify(found)}`);
}

// Checks that code reading attacker-controlled input grows linearly: 4 times the input should take about 4 times
// the time, not 16 times (quadratic), and the big input should stay inside its budget. I time the two sizes in
// turns and take the best of 3, so a garbage-collection pause can't fail it on its own, and only compare ratios
// once the times are big enough to measure reliably. A miss gets measured again before it's reported.
function assertLinear(fn, makeInput, units, n = 50000, budget = 400) {
  for (const unit of units) {
    const smallInput = makeInput(unit, n);
    const bigInput = makeInput(unit, n * 4);
    retrySlow(() => {
      const [small, big] = bestOfPair(
        () => fn(smallInput),
        () => fn(bigInput),
        4,
      );
      // Growth only means something once the timings rise above scheduler and garbage-collection noise. A 1 ms
      // run next to a 20 ms run with a GC pause once looked "quadratic" when it wasn't. The budget catches the rest.
      const grew =
        big.wall >= 50 &&
        grewMoreThan(small, big, 10) &&
        `${JSON.stringify(unit)}: ${small.wall.toFixed(1)} → ${big.wall.toFixed(1)} ms for 4× the input`;
      if (big.over(budget))
        return `${JSON.stringify(unit)}: ${big.wall.toFixed(1)} ms (${big.cpu.toFixed(0)} of processor, ${big.allowed.toFixed(0)} allowed on this computer now) for ${n * 4} repeats`;
      return grew || undefined;
    });
  }
}

function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `"${text}" → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match]);
}

function expectNothing(text) {
  assert.deepEqual(detect(text), {}, `"${text}" should not match`);
}

// These look like real keys but aren't. Real keys are random, so repetitive or documentation-style keys are
// ignored as placeholders instead of being flagged.
const FAKE = {
  aws: "AKIA4HPQ7XZ2R6TWLJ3N",
  github: "ghp_" + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi",
  anthropic: "sk-ant-api03-Zq8Lm2Xv9Rt4Kp7Wn1Bc6Hy3Jd5Gf0Qs",
  openai: "sk-proj-Hk3Pq9Zr7Tm2Xw5Lv8Nb1Cy4Jg6Df0Sa",
};

test("credentials", () => {
  expectOnly(`key ${FAKE.aws} here`, "aws_access_key");
  expectOnly(FAKE.github, "github_token");
  expectOnly(FAKE.anthropic, "anthropic_key");
  expectOnly(FAKE.openai, "openai_key");
  expectOnly("sk-" + "T3BlbkFJ9xQ2mZ7Lr4Wv8Kp1Nc6Hy5Gd0Bs3", "openai_key"); // legacy format
  expectOnly("-----BEGIN RSA PRIVATE KEY-----", "private_key");
  // A Google key may end in a dash
  expectOnly("maps key AIzaHvneKu6rq2gXKZtw-eOhOYwuVw6AAiq_ps- is failing", "google_api_key");
});

// Private keys written as JSON Web Keys (RFC 7517/7518), not just PEM/OpenSSH. Every value below is made up.
test("private keys written as JSON Web Keys: classic types (EC, OKP, RSA, oct) and JWKS entries", () => {
  const ec =
    '{"kty":"EC","crv":"P-256","x":"MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4","y":"4Etl6SRW2YiLUrN5vfvMzUyyg1NdGxLmzmF3zELsrQI","d":"870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE"}';
  expectOnly(`here's my key ${ec} for the service`, "private_key", ec);

  const okp =
    '{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","d":"nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"}';
  expectOnly(okp, "private_key", okp);

  const rsa =
    '{"kty":"RSA","n":"sXchDaQebHnPiSweGyDb","e":"AQAB","d":"T1KM8OI0dDh3TALxqw","p":"4BzEerfLdz3C","q":"uQvoY5d3i4aD","dp":"BwKfV2m7j","dq":"h_96VwkOh","qi":"IYd5PYaQp"}';
  expectOnly(rsa, "private_key", rsa);

  const oct = '{"kty":"oct","k":"GawgguFyGrWKav7AX4VKUg"}';
  expectOnly(`stored as ${oct} in the vault`, "private_key", oct);

  // RFC 9964's post-quantum ML-DSA type uses "AKP", with a 32-byte seed in "priv" and the matching public key in "pub".
  const akp =
    '{"kty":"AKP","alg":"ML-DSA-65","pub":"3bU9fQe6pL8xK2mN7vJhYtRcWz5DqFsXoGaE1nBuHiV0","priv":"c2VlZC1iYXNlNjR1cmwtcGxhY2Vob2xkZXItMzJieXRlcw"}';
  expectOnly(akp, "private_key", akp);

  // This one is pretty-printed and sits inside a JWKS `"keys"` array next to a public key; only the private entry
  // gets reported.
  const okpEntry = `{
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "60mR98VY0_ElNtsEs2Jl0qhqkwrIXtPWMBuZQfceUAw",
      "d": "0g5TTEzvdX3fRbXGXPYiBNZ3VLCl7_zAMXl3Pwzu0s4"
    }`;
  const jwks = `{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"
    },
    ${okpEntry}
  ]
}`;
  expectOnly(jwks, "private_key", okpEntry);
});

test("private keys written as JWKs: look-alikes stay quiet", () => {
  // A public JWK, with no private member, is safe to share.
  expectNone(
    '{"kty":"EC","crv":"P-256","x":"MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4","y":"4Etl6SRW2YiLUrN5vfvMzUyyg1NdGxLmzmF3zELsrQI"}',
  );
  // A whole public JWKS stays quiet too, since every entry in it is public.
  expectNone(
    '{"keys":[{"kty":"RSA","n":"sXchDaQebHnPiSweGyDb","e":"AQAB"},{"kty":"EC","crv":"P-256","x":"f83OJ","y":"x_FEz"}]}',
  );
  // A "d" field only counts as the private member when it sits inside an object that has a valid "kty".
  expectNone('{"id":1,"d":"this is a day count, not a key"}');
  expectNone('{"shape":"square","d":12}'); // "d" as a diameter, and not even a string
  // An OpenID configuration document has no "kty" at all, so it stays quiet.
  expectNone(
    '{"issuer":"https://example.com","jwks_uri":"https://example.com/jwks.json","authorization_endpoint":"https://example.com/authorize","response_types_supported":["code"]}',
  );
});

test("private keys written as JWKs: JS object literals and Python dicts pasted as code", () => {
  // Unquoted keys, as a JS object literal.
  expectOnly(
    "const key = {kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A'};",
    "private_key",
  );
  // A Python dict, single-quoted.
  expectOnly("key = {'kty': 'oct', 'k': 'GawgguFyGrWKav7AX4VKUg'}", "private_key");
});

test("private keys written as JWKs: escapes inside a single-quoted value read correctly", () => {
  // A value with an escaped double quote used to break the loose reader entirely: it re-escaped the quote a
  // second time on top of the backslash already there, which left the converted text invalid JSON and the key
  // unflagged.
  expectOnly("const key = {kty: 'oct', k: 'AQID\\\"BAUG'};", "private_key", "{kty: 'oct', k: 'AQID\\\"BAUG'}");
  // An escaped single quote (an apostrophe inside the value) stays a literal quote.
  expectOnly(
    "key = {'kty': 'oct', 'k': 'it\\'s a secret 12345'}",
    "private_key",
    "{'kty': 'oct', 'k': 'it\\'s a secret 12345'}",
  );
  // A bare double quote, with no backslash in front of it, still gets escaped for JSON.
  expectOnly("key = {'kty': 'oct', 'k': 'say \"hi\" 12345'}", "private_key", "{'kty': 'oct', 'k': 'say \"hi\" 12345'}");
  // A value ending in an escaped backslash, right before the closing quote, doesn't get mistaken for an
  // escaped quote.
  expectOnly("key = {'kty': 'oct', 'k': 'abc\\\\'}", "private_key", "{'kty': 'oct', 'k': 'abc\\\\'}");
  // A \n escape sequence passes through untouched.
  expectOnly("key = {'kty': 'oct', 'k': 'line1\\nline2'}", "private_key", "{'kty': 'oct', 'k': 'line1\\nline2'}");
});

test("private keys written as JWKs: stay fast on huge or hostile JSON", () => {
  const detectOnly = (text) => globalThis.Clotr.detect(text);
  // This is the worst case for a scan that tries every "{" as a span's start: a huge object with no closing brace
  // anywhere, which makes a backtracking "\{[^{}]*\}" reading go quadratic.
  assertLinear(detectOnly, (u, n) => "{" + u.repeat(n), ['"kty":"EC",', "no brace here, "], 20000);
  // Many small, unrelated objects in a row, like a huge log or export file, still read in linear time.
  assertLinear(detectOnly, (u, n) => u.repeat(n), ['{"a":1},', '{"kty":"x"},'], 20000);
});

// otp_secret is the secret an authenticator app uses to make your sign-in codes, so anyone who has it can make the
// codes too. People paste it as the otpauth:// link a sign-in QR code holds, as Google Authenticator's export link,
// or as the "setup key" a site shows under the QR code. Every secret below is made up.
test("two-step sign-in keys: the otpauth link in a sign-in QR code, and its export link", () => {
  const link = "otpauth://totp/GitHub:mrivera?secret=N4XQ2ZK7PLM3RTY5&issuer=GitHub";
  expectOnly(link, "otp_secret", link);
  expectOnly(`what is this? ${link}`, "otp_secret", link);
  expectOnly(`(${link}).`, "otp_secret", link);
  // An email in the link's label is part of the key's warning, not a warning of its own.
  const dropbox =
    "otpauth://totp/Dropbox:m.rivera%40northwind-mail.net?secret=K5QW4ZLTMFZXI4TBNZTW64TJMRSWE3DF&issuer=Dropbox&algorithm=SHA1&digits=6&period=30";
  expectOnly(`here is the link from the QR: ${dropbox}`, "otp_secret", dropbox);
  expectOnly("OTPAUTH://HOTP/Acme:ops?secret=QK3V7WXN2HDR6TZM&counter=4", "otp_secret");
  const exported =
    "otpauth-migration://offline?data=CigKFH7rPq4Lz9M2xWvB5nTc1Ys8EjhfEgVsdWNpYRoFR2l0SHViIAEoATACEAEYASAA";
  expectOnly(`I exported my codes, here: ${exported}`, "otp_secret", exported);
});

test("two-step sign-in keys: the setup key a site shows under its QR code, in English and Spanish", () => {
  expectOnly(
    "my google authenticator setup key is 5dkq 7xh2 mpl4 ab3z qrst uv6w yz23 kd7e what do I do with it",
    "otp_secret",
    "5dkq 7xh2 mpl4 ab3z qrst uv6w yz23 kd7e",
  );
  expectOnly("2FA secret: N4XQ2ZK7PLM3RTY5", "otp_secret", "N4XQ2ZK7PLM3RTY5");
  expectOnly("my 2fa backup secret is N4XQ 2ZK7 PLM3 RTY5", "otp_secret", "N4XQ 2ZK7 PLM3 RTY5");
  expectOnly(
    "Can't scan it? Enter this key in your authenticator app: N4XQ 2ZK7 PLM3 RTY5 then type the code",
    "otp_secret",
    "N4XQ 2ZK7 PLM3 RTY5",
  );
  expectOnly("TOTP seed = QK3V7WXN2HDR6TZM", "otp_secret", "QK3V7WXN2HDR6TZM");
  expectOnly(
    "la clave de configuración del autenticador es 5dkq 7xh2 mpl4 ab3z qrst uv6w yz23 kd7e",
    "otp_secret",
    "5dkq 7xh2 mpl4 ab3z qrst uv6w yz23 kd7e",
  );
  // A long key with no digit in it still counts as a key; about one in a thousand of the 32-letter keys Google
  // shows has no digit.
  expectOnly("authenticator setup key: hjkq wmzt pnxr dfgv bkcl mqsw tzxn plkr", "otp_secret");
});

test("two-step sign-in keys: talk about two-step sign-in, the documentation's example and placeholders stay quiet", () => {
  for (const text of [
    "scan the otpauth QR in your app",
    "Can't scan the QR code? Enter the setup key instead.",
    "What's the difference between TOTP and HOTP in authenticator apps like Authy?",
    "My authenticator app says the setup key is invalid. What does this mean and what should I check?",
    "the 2FA setup key screen says what does this mean when your code fails",
    "otpauth://totp/ACME:you?secret=JBSWY3DPEHPK3PXP&issuer=ACME", // the documentation's example secret
    "2FA secret: JBSWY3DPEHPK3PXP",
    "setup key is JBSW Y3DP EHPK 3PXP",
    "otpauth://totp/Acme?secret=YOUR_SECRET&issuer=Acme",
    "otpauth://totp/Acme?issuer=Acme&digits=6",
    "authenticator key: ABCDEFGHIJKLMNOP",
    "my authenticator code is 234567, it expires in 30 seconds",
    "¿Cómo activo la verificación en dos pasos con una app de autenticación?",
  ]) {
    const found = detect(text);
    assert.ok(!found.otp_secret && !found.password, `"${text}" → ${JSON.stringify(found)}`);
  }
  expectNothing("enable two-factor auth with a TOTP app like Authy or Google Authenticator");
});

// A paste of thousands of links or key-shaped words still reads in linear time. The first build blanked each link
// with its own pass over the whole text, which took 19 seconds on 20,000 links. The budget here leaves room for a
// busy computer.
test("two-step sign-in keys: a paste full of links or key-shaped words stays fast", () => {
  const detectOnly = (text) => globalThis.Clotr.detect(text);
  assertLinear(
    detectOnly,
    (u, n) => u.repeat(n),
    ["otpauth://totp/x?secret=N4XQ2ZK7PLM3RTY5 ", "2fa setup key: ab3d cd4e ", "my 2fa secret key is "],
    1000,
    2000,
  );
});

test("fewer false alarms: placeholders and non-random look-alikes", () => {
  // Well-known documentation/example keys and obvious placeholders
  expectNothing("AKIAIOSFODNN7EXAMPLE");
  expectNothing("AKIAABCDEFGHIJKLMNOP");
  expectNothing("AKIAXXXXXXXXXXXXXXXX");
  expectNothing("ghp_" + "a".repeat(36));
  expectNothing("sk-ant-api03-" + "x".repeat(30));
  expectNothing("sk-proj-" + "y".repeat(30));
  expectNothing("OPENAI_API_KEY=sk-your-api-key-here-1234567890");
  // Words that happen to start with sk- aren't keys
  expectNothing("I use sk-learn-is-a-great-library-for-ml every day");
  expectNothing("branch sk-My-Project-2024-Final-Draft-v2");
});

test("a house number that looks like a year (the 10,000-message oracle run)", () => {
  expectOnly(
    "Ship it to 2068 Oak Street, Albany, NY 12250 by Friday.",
    "street_address",
    "2068 Oak Street, Albany, NY 12250",
  );
  expectOnly("I live at 1999 Elm Street", "street_address", "1999 Elm Street");
});

test("phone numbers with misspelled digit words (the 10,000-message oracle run)", () => {
  expectOnly("my number is fiv fiv fiv, fiv fiv sicks, zeero one four seven", "phone_number");
  expectOnly("call five five five five five five zro one eigt seven", "phone_number");
  // Sound-alikes still need real digits on both sides, so an ordinary sentence stays quiet
  expectNothing("I won too many times to count, for real");
});

// Sound-alikes like "won", "too" and "fore" count at a spelled-out number's edge, or several side by side, when
// they make the whole run read as a phone number. Found in the 10,000-message test corpus.
test("phone numbers with sound-alikes at the edges and side by side", () => {
  for (const phone of [
    "too zeero sicks eigt thre won sicks won eigt fiv",
    "fore won fiv too seve fiv sicks seve fiv thre",
    "fiv fiv fiv too fore eigt zeero fore fiv won",
    "too zeero sicks eigt fiv nien fiv eigt thre fore",
    "too zeero sicks fore fore fore fore seve seve too",
  ])
    expectOnly(`number is ${phone} ok?`, "phone_number", phone);
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("fore won fiv too seve fiv sicks seve fiv thre"), fp("415-275-6753"));
  // A sound-alike in front of a whole number isn't part of it: "to" isn't a leading 2, even before nine digits
  expectOnly(
    "text to five five five five five five five six three six",
    "phone_number",
    "five five five five five five five six three six",
  );
  expectOnly(
    "text to two one nine zero nine nine nine nine nine",
    "phone_number",
    "two one nine zero nine nine nine nine nine",
  );
  // Everyday sentences stay quiet
  expectNothing("we won too");
  expectNothing("fore!");
  expectNothing("we won too, for the fourth time");
  expectNothing("wait for one two three four five six");
  expectNothing("I went to four or five shops, too");
});

// These three phones (m03625, m04033, m04237) were still missed by the 10,000-message test corpus: three
// sound-alikes at the edges, and more sound-alikes than number words inside, like "thre won too fore eigt …". Even
// so, "to" and "for" still don't count when they sit at an edge or outnumber the number words.
test("phone numbers with three sound-alikes at the edges, or mostly sound-alikes inside", () => {
  for (const phone of [
    "too zeero sicks seve fiv thre eigt thre won fore",
    "too zeero sicks sicks zeero fore eigt seve too won",
    "thre won too fore eigt too fore too nien fiv",
    "too fore sicks fiv fiv seve thre eigt nien won",
    "eigt won fore too fore won too won fore thre",
  ])
    expectOnly(`number is ${phone} ok?`, "phone_number", phone);
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("thre won too fore eigt too fore too nien fiv"), fp("312-482-4295"));
  // Everyday sentences with sound-alikes and number words stay quiet
  expectNothing("we won too, then won two to one, too");
  expectNothing("two to four, four to six, six to eight, eight to nine");
  expectNothing("I ate too much, for one, and won two, too");
  expectNothing("one won, two won too, three ate four, for real");
  expectNothing("too bad: we won one, too, won two, ate four, too");
  expectNothing("call me at nine to five, too, for one or two days");
});

// The regenerated 10,000-message corpus missed this phone (m01570) once the cars and school messages joined it:
// four sound-alikes at the edges, two on each side. It's caught now because any number of sound-alikes count at
// the edges when they complete a whole phone number, which the next test covers further.
test("phone numbers with four sound-alikes at the edges, when number words outnumber them", () => {
  for (const phone of [
    "fore won fiv thre won zeero nien eigt fore won",
    "too fore fiv sicks seve eigt nien zeero won fore",
    "fore won fiv thre seve too zeero nien too won",
  ])
    expectOnly(`number is ${phone} ok?`, "phone_number", phone);
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("fore won fiv thre won zeero nien eigt fore won"), fp("415-310-9841"));
  // Fewer number words than sound-alikes at the edges: still everyday words
  expectNothing("we won too, five three nine eight, won fore");
  expectNothing("fore won five three ate too");
  expectNothing("I won two, too, then five three nine one, ate four, too");
});

// The corpus missed this phone next (m00517), once the school messages joined it: "fore won" before four number
// words and "won won too fore" after them. Sound-alikes at the edges count however many there are, as long as the
// whole run reads as one phone number, whether or not a phone word comes first.
test("phone numbers after a phone word, with sound-alikes at the edges however many", () => {
  for (const [before, phone] of [
    ["number is ", "fore won fiv nien sicks eigt won won too fore"],
    ["call me on ", "too won fiv seve eigt won fore won too won"],
    ["my cell: ", "fore won fiv nien seve won won too fore won"],
  ])
    expectOnly(`${before}${phone} ok?`, "phone_number", phone);
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("fore won fiv nien sicks eigt won won too fore"), fp("415-968-1124"));
  // The same number without a phone word is still one. A phone word doesn't make a short run count as a number.
  expectOnly(
    "fore won fiv nien sicks eigt won won too fore",
    "phone_number",
    "fore won fiv nien sicks eigt won won too fore",
  );
  expectNothing("the number is fore, we won too, ate four too");
  expectNothing("call me at nine to five, too, for one or two days");
});

// Phones spelled mostly or only with sound-alikes, like "too fore won …", still count: any number of "won", "too",
// "fore" and "ate" at a spelled-out number's edges, or even the whole number made of them, as long as it reads as a
// whole phone number. About 1 in 16 misspelled phones were missed or only half caught before this.
test("phone numbers spelled mostly or only with sound-alikes", () => {
  for (const phone of [
    "too fore won too fore won fore too won too",
    "fore ate won ate fore ate won fore too fore",
    "won too fore ate too won fore too won too fore",
    "too fore nien too too eigt seve won too fore",
    "fore fiv zeero fore seve eigt seve fore won fore",
    "fore too won seve zeero seve zeero thre too fiv",
    "too won too thre fore fiv sicks seve eigt nien",
  ])
    expectOnly(`number is ${phone} ok?`, "phone_number", phone);
  expectOnly("call me at too fore won, too fore won, fore too won too", "phone_number");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("too fore won too fore won fore too won too"), fp("241-241-4212"));
  assert.equal(fp("fore too won seve zeero seve zeero thre too fiv"), fp("421-707-0325"));
  // Everyday sentences full of sound-alikes stay quiet
  expectNothing("love you too too too too too too too too too too");
  expectNothing("love you too, too, too, too, too, too, too, too, too, too, too");
  expectNothing("we won, too, and ate, too, then won too, ate too, won too");
  expectNothing("me too, me too, me too, me too, me too, me too");
  expectNothing("I ate too much too, two nights in a row, too");
  expectNothing("fore! fore! fore! we won two to one, too");
  expectNothing("we won too, won too, won too, won too, won too");
  expectNothing("text to too fore won too fore won fore too won");
  // A chant (the same one, two or three words over and over) reads as a valid number, but isn't one
  expectNothing("fore too, fore too, fore too, fore too, fore too");
  expectNothing("ate too ate too ate too ate too ate too");
  expectNothing("too won ate, too won ate, too won ate, too");
});

// Ranges and recipes like "two to four" or "one to two minutes" are everyday speech. There, "to" and "for" are
// words, not a 2 and a 4, so a recipe never reads as a 7-digit phone number or a longer SSN.
test("ranges and recipes aren't phone numbers or SSNs", () => {
  expectNothing("Mix two to four for one to two minutes");
  expectNothing("Mix two to four for one to two minutes.");
  expectNothing("for two to four for one to two for three");
  expectNothing("Mix 2 to 4 for 1 to 2 minutes");
  expectNothing("for 2 to 4 for 1 to 2 for 3");
  expectNothing("Group the kids by age: two to four, five to seven, eight to ten.");
  expectNothing("Kids from five to eight, eight to twelve, and twelve to fifteen.");
  expectNothing("Knead for two to three, rest for one to two, bake for four to five");
  expectNothing("three to four for two to three for one to two");
  expectNothing("one to two, two to three, three to four, four to five");
  // A "to" or "for" that stands for a digit inside a whole phone number still counts
  expectOnly(
    "my number is five five five for five five five six three six",
    "phone_number",
    "five five five for five five five six three six",
  );
  expectOnly(
    "call me at nine to seven, five five five, five six three six",
    "phone_number",
    "nine to seven, five five five, five six three six",
  );
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("five five five for five five five six three six"), fp("555-455-5636"));
});

// A phone keyboard's autocorrect turns only some of a spelled number's "two"s and "four"s into "to" and "for",
// anywhere in it, not only in a phone number. An SSN or a card keeps counting with one of these in the middle, and
// so does a phone number mixed with pasted digits.
test("autocorrected 'to' and 'for' inside a spelled SSN, card, or a mix of digits and words", () => {
  expectOnly(
    "Social security number two four for nine four nine to eight seven",
    "us_ssn",
    "two four for nine four nine to eight seven",
  );
  expectOnly(
    "Six one five six to four one three seven is my social, can you fill in the form",
    "us_ssn",
    "Six one five six to four one three seven",
  );
  expectOnly(
    "My visa is four zero eight eight nine one two eight one eight one zero eight seven to five",
    "credit_card",
    "four zero eight eight nine one two eight one eight one zero eight seven to five",
  );
  expectOnly("You can call 312 eight to eight 5991 tonight", "phone_number", "312 eight to eight 5991");
  expectOnly("You can call 713 to zero four 8278 tonight", "phone_number", "713 to zero four 8278");
  expectOnly("You can call 312 nine for three 1774 tonight", "phone_number", "312 nine for three 1774");
  // Still everyday speech when the shape doesn't come out whole
  expectNothing("I'm waiting for 123456789 to clear");
  expectNothing("Mix 2 to 4 for 1 to 2 minutes");
});

// The same autocorrect can also land at the very edge of the spelled run instead of inside it, and it still counts
// there. But only next to a fully spelled number, never next to a real digit run beside an ordinary "wait for …" or
// "… to clear", and never when a phone word right before it already explains it as a preposition. "text to …" still
// reads as a 9-digit number without the "to", which is the existing rule from the test above.
test("autocorrected 'to' and 'for' at the edge of a spelled SSN, card, or phone number", () => {
  expectOnly(
    "my visa is for zero zero nine for one four seven for eight one five for six six nine",
    "credit_card",
    "for zero zero nine for one four seven for eight one five for six six nine",
  );
  expectOnly(
    "My visa is for nine five two eight nine one one five zero one two two to two six",
    "credit_card",
    "for nine five two eight nine one one five zero one two two to two six",
  );
  expectOnly(
    "for five two eight seven two zero five zero is my social, can you fill in the form",
    "us_ssn",
    "for five two eight seven two zero five zero",
  );
  expectOnly(
    "for one five eight six three five four eight three is my cell, text me after six",
    "phone_number",
    "for one five eight six three five four eight three",
  );
  expectOnly(
    "Reach me at to zero six seven three three for one five one anytime.",
    "phone_number",
    "to zero six seven three three for one five one",
  );
  // A real verb right before it still reads as the preposition it is, not a borrowed digit. The bare 9 digits (or
  // whatever the core alone makes) keep their own existing rule, and "to" or "for" stays out of the match.
  expectOnly(
    "text to two one nine zero nine nine nine nine nine",
    "phone_number",
    "two one nine zero nine nine nine nine nine",
  );
  expectOnly(
    "Call for one two three four five six seven eight nine today",
    "phone_number",
    "one two three four five six seven eight nine",
  );
});

// A number word with one letter added, dropped, changed or swapped, like "sevne", "fivve", "sinco" or "nuebe",
// counts only inside a spelled-out phone number. Ordinary words next to number words stay words.
test("phone numbers with a one-letter slip in a number word", () => {
  expectOnly(
    "call me at five fivve five, five fivve five, five six three six",
    "phone_number",
    "five fivve five, five fivve five, five six three six",
  );
  expectOnly(
    "call me at five five fivve, five fivve five, five six three six",
    "phone_number",
    "five five fivve, five fivve five, five six three six",
  );
  expectOnly(
    "mi número es seis sinco nuebe, doce, treinta y cuatro, ochenta",
    "phone_number",
    "seis sinco nuebe, doce, treinta y cuatro, ochenta",
  );
  expectNothing("I'm fine, nine to five suits me");
  expectNothing("my son is nine, my daughter is five, and I'm fine");
  expectNothing("I have fiv cats and a dog, nien fish too");
  expectNothing("pero tengo cinco o seis, nueva casa");
  // "line" isn't read as "nine" when it would cost the real number before it
  expectOnly(
    "five five five five five five five six three six line two",
    "phone_number",
    "five five five five five five five six three six",
  );
});

test("credit cards (Luhn)", () => {
  expectOnly("4111 1111 1111 1111", "credit_card");
  expectNothing("4111 1111 1111 1112");
  // An Amex card's first 10 digits look like a phone number, but this should report only the card.
  expectOnly("Card 3782 822463 10005", "credit_card");
  // Book numbers (ISBN-13, with the 978/979 prefix no card network uses) pass the Luhn check about one time in
  // ten, so these should stay quiet even though a 13-digit Visa still counts.
  expectNothing("The ISBN is 978-1-299-78053-2; is that the second edition?");
  expectNothing("isbn 9780353109620");
  expectOnly("card 4222222222222", "credit_card");
});

test("credit cards spelled out in words (not mistaken for a crypto seed phrase)", () => {
  expectOnly(
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "credit_card",
  );
  expectOnly("card: four one one one, one one one one, one one one one, one one one one", "credit_card");
  expectOnly(
    "la tarjeta es cuatro cinco tres nueve, uno cuatro ocho ocho, cero tres cuatro tres, seis cuatro seis siete",
    "credit_card",
  );
  expectNothing("four one one one, one one one one, one one one one, one one one two"); // fails the checksum
  // A real seed phrase is still one
  expectOnly(
    "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
    "crypto_secret",
  );
});

test("phone numbers: digit formats", () => {
  expectOnly("(555)-555-5636", "phone_number", "(555)-555-5636");
  expectOnly("555-555-5636", "phone_number", "555-555-5636");
  expectOnly("call 555-5636 tonight", "phone_number", "555-5636");
  expectOnly("5555555636", "phone_number", "5555555636");
  expectOnly("(555) 555-5636", "phone_number", "(555) 555-5636");
  expectOnly("+1 555 555 5636", "phone_number", "+1 555 555 5636");
  expectOnly("555.555.5636", "phone_number", "555.555.5636");
  expectOnly("my number is 555 555 5636 4 kids", "phone_number", "555 555 5636");
  expectOnly("phone # 5555555636", "phone_number", "5555555636");
  expectOnly("my number is 555-555-5636x12", "phone_number", "555-555-5636");
  expectOnly("call 555-555-5636 ext. 204", "phone_number", "555-555-5636");
});

test("phone numbers: spelled out and mixed", () => {
  expectOnly("fivefivefivefivefivefivefivesixthreesix", "phone_number");
  expectOnly("5fivefiv5five5five63six", "phone_number");
  expectOnly("5fivefive5five5five63six", "phone_number");
  expectOnly("five five five five five five five six three six", "phone_number");
  expectOnly("Five-Five-Five 555 5636", "phone_number");
  expectOnly("call me at five five five, five five five, five six three six", "phone_number");
  expectOnly("it's five five five five six three six", "phone_number");
});

test("phone numbers: UK and Australian local formats", () => {
  expectOnly("my mobile is 07700 900123", "phone_number", "07700 900123");
  expectOnly("ring me on 07700900123", "phone_number", "07700900123");
  expectOnly("call 020 7946 0958", "phone_number", "020 7946 0958");
  expectOnly("my number is 0412 345 678", "phone_number", "0412 345 678");
  expectOnly("text me on 0412345678", "phone_number", "0412345678");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("07700 900123"), fp("07700-900-123"));
  expectNothing("order 07123456789 shipped");
  expectNothing("invoice 0412345678 paid");
});

test("numbered lists: the item number isn't part of the detail", () => {
  const found = detect("1. 555-555-5636\n2. 219-09-9999\n3) 555-555-1234");
  assert.deepEqual(found.phone_number, ["555-555-5636", "555-555-1234"]);
  assert.deepEqual(found.us_ssn, ["219-09-9999"]);
});

test("structured data: JSON, YAML and XML labels", () => {
  expectOnly('{"dob":"1948-03-14"}', "date_of_birth", "1948-03-14");
  expectOnly("ssn: 219099999", "us_ssn", "219099999");
  expectOnly("<ssn>219-09-9999</ssn>", "us_ssn", "219-09-9999");
  const both = detect("<phone>555-555-5636</phone><ssn>219-09-9999</ssn>");
  assert.deepEqual([both.phone_number, both.us_ssn], [["555-555-5636"], ["219-09-9999"]]);
  expectNothing("order_id: 219099999");
  assert.deepEqual(detect('{"card_number": "4111 1111 1111 1111", "cvv": "123"}').card_code, ["123"]);
  assert.deepEqual(detect("phone,ssn\n5555555636,219099999\n5555551234,078051120").us_ssn, ["219099999", "078051120"]);
  expectNothing("id,count\n219099999,5");
});

test("phone numbers: things that are not phones", () => {
  expectNothing("123-45-678"); // too short
  expectNothing("2026-09-23");
  expectNothing("$4,250,000 raised");
  expectNothing("1, 2, 3, go");
  expectNothing("09/23/2026");
  expectNothing("1234567");
  expectNothing("someone phoned at noon");
  expectNothing("one two three four five six seven");
  expectNothing("I have 2 cats and 3 dogs");
  expectOnly("server 192.168.100.200", "internal_ip"); // an internal IP, not a phone number
  expectNothing("timestamp 1727000000");
  expectNothing("$1,250,000");
  expectNothing("sixty seven people from Ohio");
  expectNothing("version 10.100.200.300");
  // Order, ticket and meeting numbers are labelled as what they are
  expectNothing("Order #445-2231987 from Amazon arrived damaged");
  expectNothing("The meeting ID is 845 2931 7710 on Zoom");
  expectNothing("ticket 555-1234 was closed, invoice no. 555-555-0199 paid");
  expectOnly("order 445-2231987 arrived, call me at 555-555-0147", "phone_number", "555-555-0147");
  expectNothing("El ID de la reunión de Zoom es 845 2931 7710");
  // An ID in a log isn't a phone, even when it reads like "00 49 …"
  expectNothing("The log says 2026-05-11T14:11:59Z request id 004940008510.");
  expectNothing("transaction ID: 004582298378 failed");
  expectOnly("request id 004940008510, call me at 555-555-0147", "phone_number", "555-555-0147");
  expectOnly("about the order, call me at 555-555-0147", "phone_number", "555-555-0147");
  expectOnly("sobre el pedido, llámame al 612 345 678", "phone_number", "612 345 678");
});

test("SSNs, including spelled out", () => {
  expectOnly("123-45-6789", "us_ssn", "123-45-6789");
  expectOnly("123 45 6789", "us_ssn", "123 45 6789");
  expectOnly("two one nine zero nine nine nine nine nine", "us_ssn");
  // Counting to nine is a count, unless it's said to be an SSN (see "counting aloud" below)
  expectOnly("my social is one two three four five six seven eight nine", "us_ssn");
  expectOnly("my social is onetwothree45sixseven89", "us_ssn");
  // A bare 9 digits alone, with nothing else in the message, reads as a reply to "what's your SSN?"
  expectOnly("123456789", "us_ssn", "123456789");
  expectNothing("000-12-3456");
  // In a list after another number
  assert.deepEqual(detect("my phone 555-555-5636, 219-09-9999 is my social").us_ssn, ["219-09-9999"]);
  assert.deepEqual(detect("ids: 5636; 219-09-9999").us_ssn, ["219-09-9999"]);
  for (const phone of [
    "five five five five five five five six three seven",
    "five five five five five five one two three four",
  ]) {
    const both = detect(`${phone}, two one nine oh nine nine nine nine nine`);
    assert.ok(both.phone_number?.length === 1 && both.us_ssn?.length === 1, JSON.stringify(both));
  }
  expectOnly("call me at five five five, five five five, five six three six", "phone_number"); // commas inside one phone
  // "dash" said as a word
  expectOnly("social security two one nine dash oh nine dash nine nine nine nine", "us_ssn");
  expectOnly("call five five five dash five five five dash one two three four", "phone_number");
});

// Typing the practice SSN without dashes in the office training's "Try it" step used to find nothing. A bare 9
// digits now counts as an SSN when the message itself says so, alone or with identity words, but never just from
// sitting near an order, tracking, invoice, account or ZIP number, or in a list of other figures.
test("a bare SSN with no dashes", () => {
  expectOnly("219099999", "us_ssn", "219099999");
  expectOnly(" 219099999 ", "us_ssn", "219099999");
  expectOnly("219099999.", "us_ssn", "219099999");
  expectOnly("My number is 219099999, is that enough to confirm who I am?", "us_ssn", "219099999");
  expectOnly("219099999 - that's enough to verify my identity, right?", "us_ssn", "219099999");
  expectOnly("¿Quién soy? 219099999", "us_ssn", "219099999");
  expectOnly("Para verificar mi identidad: 219099999", "us_ssn", "219099999");
  expectOnly("my number is 219099999", "us_ssn", "219099999");
  // None of these read as an SSN: order, tracking, invoice, account or ZIP context, or one figure among others.
  // "account" still reads the number as a bank account, as it already did; the other labels find nothing at all.
  expectNothing("order 219099999 shipped");
  expectNothing("tracking 219099999");
  expectNothing("invoice #219099999");
  expectOnly("account 219099999", "bank_account", "219099999");
  expectNothing("zip 219099999");
  expectNothing("Figures this quarter: 48213765, 219099999, 83640192");
  // Already-invalid shapes stay quiet even alone
  expectNothing("000123456");
});

test("emails, including spelled out", () => {
  expectOnly("jane.doe@example.com", "email", "jane.doe@example.com");
  expectOnly("my email is bob at gmail dot com", "email", "bob at gmail dot com");
  expectOnly("john dot smith at yahoo dot com", "email", "john dot smith at yahoo dot com");
  expectOnly("bob(at)example(dot)org", "email", "bob(at)example(dot)org");
  expectOnly("bob [at] example [dot] com", "email", "bob [at] example [dot] com");
  expectOnly("bob @ gmail . com", "email", "bob @ gmail . com");
  expectNothing("I work at google dot com");
  // URL-encoded in a pasted link
  assert.deepEqual(detect("https://example.com/signup?email=ann%40gmail.com&ref=x").email, ["ann%40gmail.com"]);
  // ...and it matches the plain address in the vault (same normalized form and fingerprint)
  assert.equal(
    globalThis.Clotr.normalize("email", "ann%40gmail.com"),
    globalThis.Clotr.normalize("email", "ann@gmail.com"),
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "ann%40gmail.com"),
    globalThis.Clotr.fingerprint("s", "email", "ann@gmail.com"),
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "Ann%40Gmail.com"),
    globalThis.Clotr.fingerprint("s", "email", "ann@gmail.com"),
  );
  // The whole address, so nothing is left behind when it is hidden
  expectOnly("contact: jane(dot)doe(at)gmail(dot)com", "email", "jane(dot)doe(at)gmail(dot)com");
  expectOnly("mi correo es juan arroba gmail punto com", "email", "juan arroba gmail punto com");
  expectOnly(
    "mi correo es juan punto perez arroba hotmail punto es",
    "email",
    "juan punto perez arroba hotmail punto es",
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "juan arroba gmail punto com"),
    globalThis.Clotr.fingerprint("s", "email", "juan@gmail.com"),
  );
  // A well-known provider without ".com", after an email word
  expectOnly("my email is janedoe at yahoo", "email", "janedoe at yahoo");
  expectOnly("email me at jane.doe at gmail", "email", "jane.doe at gmail");
  expectNothing("I work at yahoo and she is at gmail");
  // Common misspellings of the big providers, spelled out
  expectOnly("email me at bob at gmial dot com", "email", "bob at gmial dot com");
  expectOnly("my email is jane dot doe at gamil dot com", "email");
  expectOnly("write to grandpa at hotmial dot com", "email", "grandpa at hotmial dot com");
  expectOnly("its sue at yaho dot com", "email", "sue at yaho dot com");
  const efp = (m) => globalThis.Clotr.fingerprint("s", "email", m);
  assert.equal(efp("janedoe at yahoo"), efp("janedoe@yahoo.com"));
  assert.equal(efp("bob at gmial dot com"), efp("bob@gmail.com")); // a misspelled provider is still yours
  assert.equal(efp("sue at hotmial dot com"), efp("sue@hotmail.com"));
  expectNothing("look at this, meet at noon");
});

test("responses: nothing blocks by default, user overrides win", () => {
  const { responseFor, defaultResponse, PATTERNS } = globalThis.Clotr;
  for (const p of PATTERNS) {
    assert.ok(p.start === undefined || p.start === "log", `${p.id} starts at ${p.start}: only "log" may be set`);
    assert.equal(defaultResponse(p.id), p.start === "log" ? "log" : "warn", p.id);
  }
  assert.equal(responseFor("aws_access_key", { aws_access_key: "block" }), "block");
  assert.equal(responseFor("email", { email: "off" }), "log"); // no silent Off: old "off" reads as Log only
  assert.equal(responseFor("email", { email: "bogus" }), "warn");
  assert.equal(responseFor("aws_access_key", undefined), "warn");
});

// A kind can start quietly, counted but never shown, the way license plates and gamer tags do, by setting
// `start: "log"` on its pattern. The person's own choice still wins over that, and nothing can start at Ask before
// sending no matter what the pattern says. No shipped kind starts quietly here, so this test makes one quiet and
// puts it back afterward.
test("a kind can start as Just count; nothing starts at Ask before sending", () => {
  const { responseFor, defaultResponse, stricter, PATTERNS } = globalThis.Clotr;
  const p = PATTERNS.find((x) => x.id === "internal_host");
  try {
    p.start = "log";
    assert.equal(defaultResponse("internal_host"), "log");
    assert.equal(responseFor("internal_host", {}), "log");
    assert.equal(responseFor("internal_host", { internal_host: "warn" }), "warn");
    assert.equal(responseFor("internal_host", { internal_host: "block" }), "block");
    assert.equal(responseFor("internal_host", { internal_host: "off" }), "log");
    // A team's required "warn" still lifts it
    assert.equal(stricter(responseFor("internal_host", {}), "warn"), "warn");
    p.start = "block";
    assert.equal(defaultResponse("internal_host"), "warn");
    p.start = "bogus";
    assert.equal(defaultResponse("internal_host"), "warn");
  } finally {
    delete p.start;
  }
  assert.equal(defaultResponse("internal_host"), "warn");
});

test("sha256 matches node's crypto", () => {
  const { createHash } = require("node:crypto");
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "héllo ☎ 555"]) {
    assert.equal(
      globalThis.Clotr.sha256(s),
      createHash("sha256").update(s).digest("hex"),
      JSON.stringify(s).slice(0, 20),
    );
  }
});

test("fingerprints: same value however it's written", () => {
  const fp = (id, m) => globalThis.Clotr.fingerprint("salt", id, m);
  const phone = fp("phone_number", "555-555-5636");
  for (const m of [
    "(555) 555-5636",
    "555.555.5636",
    "+1 555 555 5636",
    "five five five five five five five six three six",
    "5fivefiv5five5five63six",
    "5fivefive5five5five63six",
  ]) {
    assert.equal(fp("phone_number", m), phone, m);
  }
  assert.notEqual(fp("phone_number", "555-555-5637"), phone);
  const email = fp("email", "bob@gmail.com");
  for (const m of ["Bob@Gmail.com", "bob at gmail dot com", "bob(at)gmail(dot)com", "bob [at] gmail [dot] com"]) {
    assert.equal(fp("email", m), email, m);
  }
  assert.notEqual(fp("email", "rob@gmail.com"), email);
  assert.notEqual(globalThis.Clotr.fingerprint("other-salt", "email", "bob@gmail.com"), email);
});

test("passphrases: a few plain words that end the sentence", () => {
  expectOnly("password = correct horse battery staple", "password", "correct horse battery staple");
  expectOnly("the wifi password is purple monkey dishwasher.", "password", "purple monkey dishwasher");
  expectOnly("mi contraseña es gato azul pizza fría", "password", "gato azul pizza fría");
  expectNothing("my password is the same as before");
  expectNothing("my password is changed every month");
  expectNothing("my password is too long and hard to remember");
  expectNothing("the password was reset yesterday morning");
  expectNothing("your password is required for login");
  expectNothing("my password is strong enough now");
  expectNothing("the password is safe and secure");
});

test("card security codes, remote-access codes and memorable words", () => {
  expectOnly("my card expires 12/27 and the CVV is 123", "card_code", "123");
  expectOnly("cvv 482", "card_code", "482");
  expectOnly("the security code on the back is 4821", "card_code", "4821");
  expectOnly("the AnyDesk code is 123 456 789", "password", "123 456 789");
  expectOnly("the tech support guy asked for my remote access code 889 221 334", "password", "889 221 334");
  expectOnly("my online banking memorable word is sunflower", "password", "sunflower");
  expectNothing("where is the CVV on a card?");
  expectNothing("my wallet address is 0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
  expectNothing("my bank card ends in 1234");
});

test("Spanish: card, door and remote-access codes, and a password without 'es'", () => {
  expectOnly("el CVV es 123", "card_code", "123");
  expectOnly("el código de seguridad de la tarjeta es 482", "card_code", "482");
  expectOnly("el código de AnyDesk es 123 456 789", "password", "123 456 789");
  expectOnly("el código del portal es 4821", "password", "4821");
  expectOnly("mi usuario es jperez y la contraseña Luna2020", "password", "Luna2020");
  expectNothing("¿dónde está el CVV de la tarjeta?");
  expectNothing("el código postal es 28013 y el código de área es 91");
});

// A card's security code counts however people say it. A scam caller asks for "the 3 numbers on the back", so the
// person types it that way, which testing once found this missed. This test covers its names (CVV, CVC, CVV2,
// CSC), where it sits on the card (the back, or the front for an Amex's 4 digits), and the code typed as digits,
// spaced, spelled out, with sound-alikes, in curly quotes, or after a phone keyboard's dot.
test("card security codes: every everyday way of saying it", () => {
  const both = detect("the card is 4111 1111 1111 1111 and the 3 numbers on the back are 123");
  assert.deepEqual(both.card_code, ["123"]);
  assert.deepEqual(both.credit_card, ["4111 1111 1111 1111"]);
  // Where it is on the card
  expectOnly("the 3 numbers on the back are 123", "card_code", "123");
  expectOnly("the three digits on the back of the card are 482", "card_code", "482");
  expectOnly("the 3 digits on the back of my credit card: 739", "card_code", "739");
  expectOnly("the code on the back is 4821", "card_code", "4821");
  expectOnly("the numbers on the back of my debit card are 561", "card_code", "561");
  expectOnly("the last 3 digits on the back are 905", "card_code", "905");
  expectOnly("3 digit code on the back 274", "card_code", "274");
  expectOnly("the three numbers on the reverse are 318", "card_code", "318");
  expectOnly("back of my card: 739", "card_code", "739");
  expectOnly("the back of my card says 739", "card_code", "739");
  expectOnly("on the back of my card it says 274", "card_code", "274");
  expectOnly("the 3 numbers behind the card are 646", "card_code", "646");
  expectOnly("the 4 digits on the front are 1234", "card_code", "1234");
  expectOnly("the four numbers on the front of my Amex are 3456", "card_code", "3456");
  expectOnly("the cvv on the back of my card is 123", "card_code", "123");
  // Its names
  expectOnly("my CSC is 123", "card_code", "123");
  expectOnly("CVV2: 456", "card_code", "456");
  expectOnly("CVC 789", "card_code", "789");
  expectOnly("the CVV code is 321", "card_code", "321");
  expectOnly("ccv 482", "card_code", "482");
  expectOnly("card verification code: 482", "card_code", "482");
  expectOnly("the 3 digit security code is 551", "card_code", "551");
  // However the code is typed
  expectOnly("the CVV is one two three", "card_code", "one two three");
  expectOnly("the 3 numbers on the back are four eight two", "card_code", "four eight two");
  expectOnly("the security code is four fifty-two", "card_code", "four fifty-two");
  expectOnly("the cvv is 4 8 2", "card_code", "4 8 2");
  expectOnly("the cvv is 4 eight 2", "card_code", "4 eight 2");
  expectOnly("the code on the back is oh four two", "card_code", "oh four two");
  expectOnly("the cvv is won too ate", "card_code", "won too ate");
  expectOnly("the three numbers on the back are sevne one nine", "card_code", "sevne one nine");
  expectOnly("the CVV is “482”", "card_code", "482");
  expectOnly("the card’s security code is 482", "card_code", "482");
  expectOnly("the 3 numbers on the back. Are 482", "card_code", "482");
  expectOnly("the cvv is. Four eight two", "card_code", "Four eight two");
  expectOnly('{"card": {"cvc": "317"}}', "card_code", "317");
});

test("card security codes in Spanish", () => {
  expectOnly("los 3 números de atrás son 123", "card_code", "123");
  expectOnly("los tres dígitos de atrás de la tarjeta son 482", "card_code", "482");
  expectOnly("los numeros de atras: 739", "card_code", "739");
  expectOnly("los 3 números del reverso de mi tarjeta: 739", "card_code", "739");
  expectOnly("los 3 números que están atrás son 561", "card_code", "561");
  expectOnly("los números de la parte de atrás de mi tarjeta de crédito son 905", "card_code", "905");
  expectOnly("el código de atrás de la tarjeta es 4821", "card_code", "4821");
  expectOnly("el código de seguridad de atrás es 482", "card_code", "482");
  expectOnly("la parte de atrás de mi tarjeta dice 274", "card_code", "274");
  expectOnly("los 4 números del frente de la tarjeta son 1234", "card_code", "1234");
  expectOnly("el CVV de mi tarjeta es 123", "card_code", "123");
  expectOnly("el código de seguridad es cuatro ocho dos", "card_code", "cuatro ocho dos");
  expectOnly("los 3 números de atrás son cuatrocientos ochenta y dos", "card_code", "cuatrocientos ochenta y dos");
  expectOnly("el cvv es “317”", "card_code", "317");
});

// A card's security code is a money detail, not a way into an account, so it's its own kind beside the card's
// number. Silencing passwords doesn't silence it, and its advice is a card's advice. Every phrasing above moved
// over from "Password or Secret", and the password kind no longer reports any of them.
test("a card's security code is its own kind, beside the card's number, and never a password as well", () => {
  const { PATTERNS } = globalThis.Clotr;
  const kind = PATTERNS.find((p) => p.id === "card_code");
  assert.deepEqual([kind.group, kind.severity, kind.name], ["personal", "high", "Card Security Code"]);
  const ids = PATTERNS.map((p) => p.id);
  assert.equal(ids.indexOf("card_code"), ids.indexOf("credit_card") + 1, "listed right after the card's number");
  const findSecrets = PATTERNS.find((p) => p.id === "password").find;
  for (const text of [
    "the CVV is 123",
    "the 3 numbers on the back are 123",
    "back of my card: 739",
    "los 3 números de atrás son 123",
    "el código de seguridad de la tarjeta es 482",
    "card verification code: 4821",
    "the security code is four fifty-two",
  ])
    assert.deepEqual(findSecrets(text), [], text);
  // "verification code" is a label another password rule also reads, but the value is still one detail of one kind.
  expectOnly("card verification code: 4821", "card_code", "4821");
  expectOnly("the card verification code is 4821", "card_code", "4821");
  // A password beside a card's code: each is its own kind.
  const both = detect("password: Fluffy123! and the CVV is 482");
  assert.deepEqual([both.password, both.card_code], [["Fluffy123!"], ["482"]]);
  // A sign-in code is still a password.
  expectOnly("the verification code is 4821", "password", "4821");
});

test("advice for a card's security code that went out: call the card company, not a password's", () => {
  require("../extension/insights.js");
  const { adviceFor } = globalThis.ClotrInsights;
  assert.equal(
    adviceFor("card_code"),
    "Call the number on your card and ask for a new one if someone else could have it.",
  );
  assert.notEqual(adviceFor("card_code"), adviceFor("password"));
});

// Two places treat money details alike: the warning's line on who really asks, behind "Why am I seeing this?", and
// the report's risky moments. A card's code used to count as a password there; now it counts as a card detail.
test("a card's security code still gets the warning's scam line and counts as a risky moment in the report", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "extension", f), "utf8");
  const scam = /const SCAM_TARGETS = new Set\(\[([^\]]*)\]\)/.exec(read("warning-ui.js"))[1];
  assert.match(scam, /"card_code"/);
  const risky = /function renderRisky[\s\S]*?\[([^\]]*)\]\.includes\(e\.type\)/.exec(read("dashboard.js"))[1];
  assert.match(risky, /"card_code"/);
});

// None of these are a card's code: another thing's back, a description of the code, a product code, a room
// number, a course, the expiry date or the card's own number, and a bare three-digit number with nothing about a
// card.
test("card security codes: ordinary sentences stay quiet", () => {
  for (const text of [
    "the 3 numbers on the back of the jersey",
    "the 3 numbers on the back of the jersey are 123",
    "the back of the book has 3 numbers",
    "3 numbers on the back of the receipt",
    "the 3 numbers on the back of the receipt are 451",
    "the 3 numbers on the back of the box",
    "the three digits on the back are worn off",
    "the code on the back of the router is 4821",
    "the product code on the back is 123",
    "product code 123",
    "my room number is 123",
    "we're in room 123",
    "123",
    "I scored 123 points",
    "call extension 123",
    "I'm taking CSC 210 this fall",
    "CSC 101 homework help",
    "import cv2 4.8.0",
    "the CVV is three digits long",
    "the CVV is 3 or 4 digits",
    "the security code is three to four digits",
    "the cvv is 3 digits on the back, 4 on the front for Amex",
    "the code on the back is too faded to read",
    "the cvv is for online purchases",
    "what are the 3 numbers on the back for?",
    "the three numbers on the back are the same as last time",
    "the security code is 12/27",
    "the CVV is one",
    "the 4 digits on the front of the box are 2024",
  ])
    expectNothing(text);
  expectOnly("the numbers on the front of my card are 4111 1111 1111 1111", "credit_card");
  for (const text of [
    "los 3 números de atrás de la camiseta",
    "los 3 números de atrás de la camiseta son 123",
    "la parte de atrás del libro tiene 3 números",
    "el código del producto es 123",
    "estamos en la habitación 123",
    "el CVV son 3 dígitos",
    "el código de atrás es once",
  ])
    expectNothing(text);
});

test("card security codes stay fast on hostile text", () => {
  const detectOnly = (text) => globalThis.Clotr.detect(text);
  assertLinear(
    detectOnly,
    (u, n) => u.repeat(n),
    [
      "cvv ",
      "the cvv is one ",
      "the 3 numbers on the back are ",
      "the 3 numbers on the back of ",
      "back of my card ",
      "los 3 números de atrás ",
      "el código de seguridad es ",
      "the the 3 3 ",
    ],
    2000,
  );
  assertLinear(detectOnly, (u, n) => "the cvv is " + u.repeat(n), [" ", "one ", "4 ", "won "], 5000);
});

// A gift card's numbers are what scammers most often ask older people to pay with, per the FTC. This looks for them
// after a gift card word in the same sentence or the one before: 10 to 25 letters and digits with at least two
// digits, whole or in groups, plus a PIN after it in the same sentence as part of the same find. It's its own
// kind, beside the card's number.
test("gift card codes: a gift card's word, then its numbers (and its PIN)", () => {
  const kind = globalThis.Clotr.PATTERNS.find((p) => p.id === "gift_card");
  assert.deepEqual([kind.group, kind.severity, kind.name], ["personal", "high", "Gift Card Code"]);
  // The practice drill, in both languages: the code and its PIN count as one kind, and the PIN isn't also a password.
  assert.deepEqual(detect("the gift card code is 7KQ2-9PMX-4RT8 and the pin is 4471"), {
    gift_card: ["7KQ2-9PMX-4RT8", "4471"],
  });
  assert.deepEqual(detect("el código de la tarjeta regalo es 7KQ2-9PMX-4RT8 y el pin es 4471"), {
    gift_card: ["7KQ2-9PMX-4RT8", "4471"],
  });
  expectOnly("the gift card code is 7KQ2-9PMX-4RT8", "gift_card", "7KQ2-9PMX-4RT8");
  expectOnly("the gift card code is 7kq2-9pmx-4rt8", "gift_card", "7kq2-9pmx-4rt8");
  expectOnly("my Amazon gift card claim code is AQ7X-9KMRT2-XL4P", "gift_card", "AQ7X-9KMRT2-XL4P");
  expectOnly("claim code: AQ7X-9KMRT2-XL4P", "gift_card", "AQ7X-9KMRT2-XL4P");
  expectOnly("here's the Apple gift card X4K9PQ2M7RT8WZ3N", "gift_card", "X4K9PQ2M7RT8WZ3N");
  expectOnly("Google Play card: 7KQ2 PMXR 4RT8 W9ZL B3NC", "gift_card", "7KQ2 PMXR 4RT8 W9ZL B3NC");
  expectOnly("Steam card code 7K2PQ-9MXR4-T8WZ3", "gift_card", "7K2PQ-9MXR4-T8WZ3");
  expectOnly("the redemption code is 7KQ29PMX4RT8", "gift_card", "7KQ29PMX4RT8");
  expectOnly("my egift card number: 6006 4917 3825 6104", "gift_card", "6006 4917 3825 6104");
  expectOnly("Xbox gift card 7KQ2P-9PMXR-4RT8W-W9ZLB-B3NCQ", "gift_card", "7KQ2P-9PMXR-4RT8W-W9ZLB-B3NCQ");
  assert.deepEqual(detect("my Walmart gift card number is 6006 4917 3825 6104 and the PIN is 2468"), {
    gift_card: ["6006 4917 3825 6104", "2468"],
  });
  // The FTC's own words for what scammers ask: "the numbers off the back of the card".
  expectOnly("the numbers off the back of the card are 7KQ2 9PMX 4RT8", "gift_card", "7KQ2 9PMX 4RT8");
  expectOnly("the numbers on the back of the gift card: 7KQ2-9PMX-4RT8", "gift_card", "7KQ2-9PMX-4RT8");
  // The word in the sentence before.
  assert.deepEqual(
    detect("I bought two Steam cards for the man from the IRS. The codes are 7K2PQ-9MXR4-T8WZ3 and 4M8RT-2KQ9X-PW7N3."),
    { gift_card: ["7K2PQ-9MXR4-T8WZ3", "4M8RT-2KQ9X-PW7N3"] },
  );
  // Spanish.
  expectOnly("tarjeta de Google Play: 7KQ2 9PMX 4RT8 W3ZN", "gift_card", "7KQ2 9PMX 4RT8 W3ZN");
  expectOnly("el código de canje es AQ7X-9KMRT2-XL4P", "gift_card", "AQ7X-9KMRT2-XL4P");
  expectOnly("compré dos tarjetas regalo de Amazon. Los códigos son AQ7X-9KMRT2-XL4P", "gift_card", "AQ7X-9KMRT2-XL4P");
});

test("gift card codes: a real card's number is a card number, and a gift card's PIN alone stays a password", () => {
  // A Visa gift card is a real card: its number is the card's (Luhn and all), as before.
  expectOnly("my Visa gift card number is 4111 1111 1111 1111", "credit_card", "4111 1111 1111 1111");
  // A PIN with no gift card's numbers before it is read as a PIN is today.
  expectOnly("my gift card pin is 4471", "password", "4471");
  expectOnly("gift card pin 4471", "password", "4471");
});

test("gift card codes: a gift, a balance, the last four, an order or a link stay quiet", () => {
  for (const text of [
    "I got a $50 Amazon gift card",
    "gift card balance: $25.00",
    "my Amazon gift card ending in 4421",
    "order 112-4567890-1234567",
    "Can I pay for order 112-4567890-1234567 with an Amazon gift card?",
    "redeem it at amazon.com/redeem",
    "the gift card code didn't work",
    "the gift card code didn't work, it says the code is invalid",
    "I bought 3 Roblox gift cards. Season 4 just dropped.",
    "Use promo code SAVE20 with your gift card",
    "can the Apple gift card pay for an iPhone15ProMax?",
    "I sent a $25 Starbucks gift card to 3 coworkers on 10/12/2026",
    "A gift card for 2 people, valid until 2027",
    "Steam card prices went up 15% this year, from $20 to $23",
    "me regalaron una tarjeta regalo de 50 €",
    "el saldo de la tarjeta regalo es 25,00 €",
    "el código de la tarjeta regalo no funciona",
    // The company's own number, on the back of the card.
    "call the number on the back of the gift card, 1-888-280-4331",
    "call the number on the back of the gift card: +1 888 280 4331",
  ])
    expectNothing(text);
  // A person's phone number near a gift card is a phone number.
  expectOnly("the gift card came with a note: call me at (555) 555-0123", "phone_number", "(555) 555-0123");
  expectOnly("the gift card came with a note: call me at 555 555 0123", "phone_number", "555 555 0123");
});

test("a gift card's code that went out gets the warning's scam line, counts in the report, and its advice says to call the gift card company", () => {
  require("../extension/insights.js");
  const { adviceFor } = globalThis.ClotrInsights;
  assert.equal(
    adviceFor("gift_card"),
    "Call the gift card company on the number on the back of the card. Say a scammer got the number and PIN, and ask for your money back.",
  );
  const fs = require("fs");
  const path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "extension", f), "utf8");
  assert.match(/const SCAM_TARGETS = new Set\(\[([^\]]*)\]\)/.exec(read("warning-ui.js"))[1], /"gift_card"/);
  assert.match(
    /function renderRisky[\s\S]*?\[([^\]]*)\]\.includes\(e\.type\)/.exec(read("dashboard.js"))[1],
    /"gift_card"/,
  );
});

// The codes a scammer asks for still show as "Password or Secret" on screen, but each gets a reason saying which
// kind of code it is, and History records the kind underneath. The order checked is login_code, remote_code,
// recovery_codes, security_answer, then home_code. A plain password, a key or a cookie gets no reason at all.
const asksOf = (text) => globalThis.Clotr.detect(text).find((r) => r.id === "password")?.asks;

test("password reasons: each scam code says which kind of code it is", () => {
  for (const [text, reason] of [
    ["the code they texted me is 482913", "login_code"],
    ["the verification code is 4821", "login_code"],
    ["el código que me mandaron es 482913", "login_code"],
    ["my AnyDesk code is 123 456 789", "remote_code"],
    ["the tech support guy asked for my remote access code 889 221 334", "remote_code"],
    ["el código de AnyDesk es 123 456 789", "remote_code"],
    ["backup codes are 1234 5678, 2345 6789", "recovery_codes"],
    ["mis códigos de respaldo son 1234 5678, 2345 6789", "recovery_codes"],
    ["my mother's maiden name is Smith", "security_answer"],
    ["the answer to my security question is Rover", "security_answer"],
    ["el apellido de soltera de mi madre es García", "security_answer"],
    ["the gate code is 4821", "home_code"],
    ["my ATM pin is 4821", "home_code"],
    ["el código del portal es 4821", "home_code"],
    ["el pin de la tarjeta 4821", "home_code"],
  ])
    assert.deepEqual(asksOf(text), [reason], text);
});

test("password reasons: none for a plain password, a key or a cookie; a mix lists only the codes, in order", () => {
  for (const text of [
    "password: hunter2!",
    "my password is Fluffy123",
    "DB_PASSWORD=Xk9#mQ2vLp",
    "Cookie: sessionid=8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s; theme=dark",
    "PIN: 4821",
  ]) {
    const result = globalThis.Clotr.detect(text).find((r) => r.id === "password");
    assert.ok(result, `${text}: no password found`);
    assert.equal(result.asks, undefined, text);
  }
  const mix = globalThis.Clotr.detect("password: Fluffy123! and the code they texted me is 482913");
  assert.deepEqual(
    mix.map((r) => [r.id, r.matches, r.asks]),
    [["password", ["Fluffy123!", "482913"], ["login_code"]]],
  );
  assert.deepEqual(asksOf("the gate code is 4821 and the code they texted me is 482913"), ["login_code", "home_code"]);
  // A card's code or a gift card's is its own kind, so the password kind gets no reason at all here.
  assert.equal(asksOf("the CVV is 123 and the gift card code is 7KQ2-9PMX-4RT8"), undefined);
});

test("password reasons never outlive their match, and the password finder without a map is unchanged", () => {
  // A code a rule found but the value checks then dropped, like six of the same digit as a placeholder, leaves no
  // reason behind.
  const kept = globalThis.Clotr.detect("password: Fluffy123! and the code they texted me is 000000");
  assert.deepEqual(
    kept.map((r) => [r.id, r.matches, r.asks]),
    [["password", ["Fluffy123!"], undefined]],
  );
  // The reason still follows the code once a phone keyboard's stray dot is read out of it.
  assert.deepEqual(asksOf("my mother's maiden name is. Smith"), ["security_answer"]);
  // The finder returns the same values whether or not it's given a map, and the map ends up holding only what it
  // returned.
  const findSecrets = globalThis.Clotr.PATTERNS.find((p) => p.id === "password").find;
  for (const text of [
    "password: Fluffy123! and the code they texted me is 482913",
    "the gate code is 4821, backup codes are 1234 5678, 2345 6789",
    "my AnyDesk code is 123 456 789 and my mother's maiden name is Smith",
    "the CVV is 123 and the gift card code is 7KQ2-9PMX-4RT8 and the pin is 4471",
    "nothing here",
  ]) {
    const why = new Map();
    const found = findSecrets(text, why);
    assert.deepEqual(found, findSecrets(text), text);
    assert.ok(
      [...why.keys()].every((v) => found.includes(v)),
      `${text}: ${JSON.stringify([...why])}`,
    );
  }
  const why = new Map();
  findSecrets("the gate code is 4821, backup codes are 1234 5678, 2345 6789", why);
  assert.deepEqual(Object.fromEntries(why), { 4821: "home_code", "1234 5678, 2345 6789": "recovery_codes" });
});

test("gift card codes stay fast on hostile text", () => {
  const detectOnly = (text) => globalThis.Clotr.detect(text);
  assertLinear(
    detectOnly,
    (u, n) => u.repeat(n),
    ["gift card ", "gift card 7KQ2 ", "AB12 ", "gift card AB12-", "tarjeta regalo 12 ", "claim code 7K-"],
    2000,
  );
  assertLinear(detectOnly, (u, n) => "the gift card code is " + u.repeat(n), ["AB12 ", "7-", "X ", "12 "], 5000);
});

test("two-factor backup codes and recovery keys", () => {
  expectOnly(
    "my google backup codes are 1234 5678, 2345 6789, 3456 7890",
    "password",
    "1234 5678, 2345 6789, 3456 7890",
  );
  expectOnly("2FA recovery codes: 8f3k-2m9x, 7h2p-4q8w", "password", "8f3k-2m9x, 7h2p-4q8w");
  expectOnly("my bitlocker recovery key is 123456-234567-345678-456789-567890-678901-789012-890123", "password");
  expectOnly(
    "microsoft account recovery code AB12C-D34EF-5GH6I-J78KL-MN9OP",
    "password",
    "AB12C-D34EF-5GH6I-J78KL-MN9OP",
  );
  expectNothing("what are backup codes and where do I keep them?");
  expectNothing("my recovery key is lost, how do I get a new one?");
  expectOnly("mis códigos de respaldo son 1234 5678, 2345 6789", "password", "1234 5678, 2345 6789");
  expectOnly("el código de recuperación es AB12C-D34EF-5GH6I", "password", "AB12C-D34EF-5GH6I");
  expectOnly("el pin de la tarjeta 4821", "password", "4821");
  expectNothing("¿qué son los códigos de respaldo?");
});

test("session cookies in pasted headers", () => {
  expectOnly(
    "Cookie: sessionid=8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s; theme=dark",
    "password",
    "8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s",
  );
  expectOnly(
    "Set-Cookie: SID=FgT7s9kX2mQ4vL8pR1nZ6wB3yH5jD0cA; Path=/; HttpOnly",
    "password",
    "FgT7s9kX2mQ4vL8pR1nZ6wB3yH5jD0cA",
  );
  expectOnly("curl -b connect.sid=s%3AkJ8h2Lq9mX4vT7rP1wZ6nB3yF5dG0cS https://app.example.com", "password");
  expectOnly("aws_secret_access_key = Zq8Lm2Xv9Rt4Kp7Wn1Bc" + "6Hy3Jd5Gf0QsAb12Cd34", "password");
  expectNothing("the session cookie was invalid after logout; Cookie: theme=dark; lang=en");
});

test("logins, home codes and passwords told in passing", () => {
  expectOnly("my bank login is jdoe99 and the password Summer2024", "password", "Summer2024");
  const pair = detect("here's my login: jdoe@gmail.com / Fluffy!23");
  assert.deepEqual(pair.password, ["Fluffy!23"], JSON.stringify(pair));
  assert.deepEqual(detect("login jdoe@gmail.com pw Fluffy!23").password, ["Fluffy!23"]);
  expectOnly("the gate code is 1234", "password", "1234");
  expectOnly("my alarm code is 4821", "password", "4821");
  expectOnly("the garage code is 5580#", "password", "5580#");
  expectOnly("my ATM pin 4821", "password", "4821");
  expectOnly("the passcode to my phone is 482913", "password", "482913");
  expectOnly("the safe combination is 12-34-56", "password", "12-34-56");
  expectOnly("my password is my dog's name Rex2019", "password", "Rex2019");
  // Everyday codes and password talk stay quiet
  expectNothing("my zip code is 90210 and the area code is 212");
  expectNothing("my zip code is 45402 and the area code is 555");
  expectNothing("I got error code 1234 and status code 404");
  expectNothing("the password reset link expired");
  expectNothing("my password is not working since 2019");
  expectNothing("enter the code 1234 from the example");
  expectNothing("the combination 1-2-3 is easiest to remember");
  // Code that handles passwords, and API routes named login
  expectNothing("password = request.form['password']");
  expectNothing("login: POST /api/v1/login / returns 200");
  expectNothing("const pw = req.body.password; password = getpass()");
});

test("passwords and secrets written with context words", () => {
  expectOnly("password: hunter2", "password", "hunter2");
  expectOnly("DB_PASSWORD=S3cr3t!pass", "password", "S3cr3t!pass");
  expectOnly('config: { "token": "a8f3Kd92LmQ" }', "password", "a8f3Kd92LmQ");
  expectOnly("my PIN: 4821", "password", "4821");
  expectOnly("my password is Fluffy123", "password", "Fluffy123");
  expectOnly("my wifi password is sunflower", "password", "sunflower");
  expectOnly("Grandma, the password is 'bluebird'.", "password", "bluebird");
  // Not secrets: no value, placeholders, templates, ordinary words
  expectNothing("the password is required");
  expectNothing("my password is incorrect, how do I reset it?");
  expectNothing("reset your password: click the link");
  expectNothing("password: ********");
  expectNothing("password=<your password>");
  expectNothing("token: ${API_TOKEN}");
  expectNothing("api_key=your-api-key");
  expectNothing("pin: this message to the top");
  // A key after a label is reported as the key, not twice
  expectOnly("OPENAI_API_KEY=sk-proj-Hk3Pq9Zr7Tm2Xw5Lv8Nb1Cy4Jg6Df0Sa", "openai_key");
});

test("street addresses, however they're written", () => {
  expectOnly(
    "I live at 123 Main St, Springfield, IL 62704 now",
    "street_address",
    "123 Main St, Springfield, IL 62704",
  );
  expectOnly("ship to 4500 N. Oak Ridge Road Apt 4B please", "street_address", "4500 N. Oak Ridge Road Apt 4B");
  expectOnly("send it to 12 Baker Street", "street_address", "12 Baker Street");
  expectOnly("my house is 77 west 5th avenue", "street_address", "77 west 5th avenue");
  expectOnly("one twenty three main street apt 4", "street_address", "one twenty three main street apt 4");
  expectOnly("mail it to P.O. Box 1234", "street_address", "P.O. Box 1234");
  expectOnly("po box 55, Dayton, OH 45402", "street_address", "po box 55, Dayton, OH 45402");
  expectOnly(
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
    "street_address",
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
  );
  // Not addresses
  expectNothing("I bought 2 hard drive enclosures");
  expectNothing("it's a 5 minutes drive from here");
  expectNothing("I walked down Main Street yesterday");
  expectNothing("it's a 2 way street");
  expectNothing("read chapter 12 of the book");
  expectNothing("in 2024 the road was closed");
  // A house number that looks like a year is still an address; it only reads as a year after a time word.
  expectNothing("By 2030 Main Street will be pedestrian only");
  expectNothing("since 1998 Elm Street has flooded");
  expectNothing("take the 3 main roads north");
  expectNothing("a 5 star place to eat");
  expectNothing("she came in 2nd place");
  expectNothing("a 3 bedroom place near the lake");
});

// The health study's false alarms: "Dr." before a capitalised name is a doctor, not Drive.
test("a doctor's title isn't a street: 'at 3 with Dr. Okafor', 'a las 4 con el Dr. Ramírez'", () => {
  expectNone("My appointment is at 3 with Dr. Okafor about my thyroid nodule. What questions should I ask?");
  expectNone("Tengo la cita a las 4 con el Dr. Ramírez por un nódulo en la tiroides. ¿Qué le pregunto?");
  expectNone("Mañana a las 9 con la Dra. Ramírez, ¿qué llevo?");
  expectNone("I see him at 10 with Dr Patel, then at 2 with Dr. de la Cruz");
  expectNone("Follow-up At 3 With Dr. Okafor");
  // These are mid-typing, before the doctor's name even appears. Bandage used to swap "3 with Dr" for
  // [Address 1] while it was still being typed.
  expectNone("My appointment is at 3 with Dr");
  expectNone("My appointment is at 3 with Dr.");
  expectNone("I'll be there at 4 tomorrow with Dr");
  expectNone("a call at 2 from Dr");
  expectNone("seen at 11 by Dr");
  // Streets that end in Dr are still streets
  expectOnly("send it to 418 Maple Dr", "street_address", "418 Maple Dr");
  expectOnly("my address is 12 Oak Dr., Apt 4", "street_address", "12 Oak Dr., Apt 4");
  expectOnly("we moved to 500 Lakeview Drive", "street_address", "500 Lakeview Drive");
  expectOnly("418 Maple Dr. Springfield, IL 62704", "street_address", "418 Maple Dr. Springfield, IL 62704");
  expectOnly("ship it to 12 Oak Dr. Apt 4 today", "street_address", "12 Oak Dr. Apt 4");
  expectOnly("22 riverside dr Dayton OH 45402", "street_address", "22 riverside dr Dayton OH 45402");
  expectOnly("ship to 22 riverside Dr Dayton, OH 45402", "street_address", "22 riverside Dr Dayton, OH 45402");
  expectOnly("I live at 7 Willow Dr. My doctor is Dr. Okafor.", "street_address", "7 Willow Dr.");
  expectOnly("4500 El Cajon Blvd", "street_address", "4500 El Cajon Blvd");
});

test("Spanish: dates of birth, digits or words", () => {
  expectOnly("nací el 14 de marzo de 1962", "date_of_birth", "14 de marzo de 1962");
  expectOnly("mi fecha de nacimiento es 14/03/1962", "date_of_birth", "14/03/1962");
  expectOnly(
    "mi fecha de nacimiento es catorce de marzo de mil novecientos sesenta y dos",
    "date_of_birth",
    "catorce de marzo de mil novecientos sesenta y dos",
  );
  expectOnly("mi cumpleaños es el 3 de julio", "date_of_birth", "3 de julio");
  expectOnly("nació el primero de mayo de 1990 en Lima", "date_of_birth", "primero de mayo de 1990");
  expectNothing("la reunión es el 14 de marzo de 2026");
  expectNothing("nací en Madrid");
  expectNothing("mi cumpleaños es pronto");
});

test("dates of birth, digits or words", () => {
  expectOnly("I was born 3/14/1948 in Ohio", "date_of_birth", "3/14/1948");
  expectOnly("DOB: 03-14-1948", "date_of_birth", "03-14-1948");
  expectOnly("birthdate 1948-03-14", "date_of_birth", "1948-03-14");
  expectOnly("date of birth: March 14, 1948", "date_of_birth", "March 14, 1948");
  expectOnly("my birthday is March 14th", "date_of_birth", "March 14th");
  expectOnly(
    "I was born on the fourteenth of March nineteen forty eight",
    "date_of_birth",
    "fourteenth of March nineteen forty eight",
  );
  expectOnly("born March fourteenth, nineteen forty-eight", "date_of_birth", "March fourteenth, nineteen forty-eight");
  expectOnly("b-day: 14 Mar 1948", "date_of_birth", "14 Mar 1948");
  // Not a birth date
  expectNothing("the meeting is 3/14/2026");
  expectNothing("I was born in Ohio");
  expectNothing("my birthday is coming up soon");
  expectNothing("born 13/45/1948");
});

test("UK, Indian and Australian IDs: NHS, NI, Aadhaar, TFN, Medicare (checksum-validated)", () => {
  expectOnly("my NHS number is 943 476 5919", "medical_record", "943 476 5919");
  expectOnly("my national insurance number is AB 12 34 56 C", "national_id");
  expectOnly("my aadhaar is 2345 6789 0124", "national_id", "2345 6789 0124");
  expectOnly("my australian TFN is 123 456 782", "national_id", "123 456 782");
  expectOnly("my tax file number is 123 456 782", "national_id", "123 456 782");
  expectOnly("my medicare card number is 2123 45670 1", "medicare_id", "2123 45670 1");
  expectNothing("my aadhaar is 2345 6789 0123"); // wrong check digit
  expectNothing("the NHS number has 10 digits");
});

// A NINO has no check digit, so a bare match passes about 1 random code in 11.5 of its shape. Because of that, it
// only counts with an NI word nearby, caught in every format the word can come in.
test("a UK National Insurance number counts only with an NI word nearby, in every format", () => {
  for (const text of [
    "my national insurance number is AB 12 34 56 C",
    "my NINO is AB123456C",
    "NI number: ab 12 34 56 c", // lower case
    "NI no AB123456C",
    "N.I. AB 12 34 56 C",
    "mi seguro nacional es AB123456C",
  ])
    expectOnly(text, "national_id");
  // Look-alikes of the same shape stay quiet without an NI word nearby, like product codes, flight and booking
  // references, and serial numbers.
  for (const text of [
    "product code AB 12 34 56 C",
    "flight reference AB 12 34 56 C",
    "booking ref AB123456C",
    "serial number AB 12 34 56 C",
    "AB 12 34 56 C", // nothing around it at all
  ])
    expectNothing(text);
});

test("US tax and immigration numbers, VA file and Medicaid IDs", () => {
  expectOnly("my ITIN is 912-70-1234", "national_id", "912-70-1234");
  expectOnly("our EIN is 12-3456789", "national_id", "12-3456789");
  expectOnly("my tax id is 12-3456789", "national_id", "12-3456789");
  expectOnly("my A-number is A123456789", "national_id", "A123456789");
  expectOnly("my green card number is SRC1234567890", "national_id", "SRC1234567890");
  expectOnly("my VA file number is 12345678", "national_id", "12345678");
  expectOnly("my medicaid id is 12345678A", "insurance_id", "12345678A");
  expectNothing("an EIN has 9 digits and an ITIN starts with 9");
  expectNothing("order 912-40-1234 shipped"); // not an ITIN range
});

test("bank, Medicare, license, passport and insurance numbers", () => {
  expectOnly("my account number is 123456789012", "bank_account", "123456789012");
  expectOnly("routing: 021000021", "bank_account", "021000021");
  expectOnly("checking acct # 4400-1234-5678", "bank_account", "4400-1234-5678");
  expectOnly(
    "acct no. one two three four five six seven eight",
    "bank_account",
    "one two three four five six seven eight",
  );
  expectOnly("Medicare number 1EG4-TE5-MK73", "medicare_id", "1EG4-TE5-MK73");
  expectOnly("card says 1EG4TE5MK73", "medicare_id", "1EG4TE5MK73");
  expectOnly("driver's license: D1234567", "drivers_license", "D1234567");
  expectOnly("DL# S12345678", "drivers_license", "S12345678");
  expectOnly("passport number 912345678", "passport", "912345678");
  expectOnly("passport no. X12345678", "passport", "X12345678");
  expectOnly("insurance member ID: XYZ123456789", "insurance_id", "XYZ123456789");
  // Not these
  expectNothing("routing number 123456789"); // fails the ABA checksum
  expectNothing("I have 2 accounts at the bank");
  expectNothing("my account is locked, account settings won't open");
  expectNothing("check your passport is valid for 6 months");
  expectNothing("the license is MIT");
  expectNothing("member id is required");
});

// A vehicle identification number is 17 letters and digits without I, O or Q. It counts after a label in any case.
// On its own, it only counts in capitals, standing alone, and only when everything about it is right: the check
// digit, the model year and the last four digits. That way codes that merely look like a VIN stay quiet, while
// next to a vehicle word the check digit alone is enough. Every VIN here is made up; 1HGCM82633A004352 is the
// usual textbook example.
test("VIN: labelled, in English and Spanish, in any case", () => {
  expectOnly("my VIN is 1HGCM82633A004352", "vin", "1HGCM82633A004352");
  expectOnly("VIN: 1hgcm82633a004352", "vin", "1hgcm82633a004352");
  expectOnly("VIN#1M8GDM9AXKP042788 for the recall", "vin", "1M8GDM9AXKP042788");
  expectOnly("the VIN number is 5YJ3E1EA2KF317000", "vin", "5YJ3E1EA2KF317000");
  // A European VIN has no check digit, so its label is what tells
  expectOnly("vehicle identification number WVWZZZ1JZXW000001", "vin", "WVWZZZ1JZXW000001");
  expectOnly("chassis no. JMZBK12Z501234567 on the logbook", "vin", "JMZBK12Z501234567");
  expectOnly("Mi número de bastidor es VSSZZZ6JZ9R123456", "vin", "VSSZZZ6JZ9R123456");
  expectOnly("mi número VIN es VSSZZZ6JZ9R123456", "vin", "VSSZZZ6JZ9R123456");
  expectOnly("el NIV de mi camioneta: 3VWFE21C04M000001", "vin", "3VWFE21C04M000001");
  // Latin America says "chasis"; Mexico's papers call the VIN the car's "número de serie"
  expectOnly("número de chasis VSSZZZ6JZ9R123456", "vin", "VSSZZZ6JZ9R123456");
  expectOnly("Nº de chasis: WVWZZZ1JZXW000001, ¿está bien?", "vin", "WVWZZZ1JZXW000001");
  expectOnly("el número de serie de mi camioneta es VSSZZZ6JZ9R123456", "vin", "VSSZZZ6JZ9R123456");
  expectOnly("Número de serie del vehículo: WVWZZZ1JZXW000001", "vin", "WVWZZZ1JZXW000001");
});

test("VIN: unlabelled, with a vehicle word and a right check digit", () => {
  expectOnly("I'm selling my 2003 Honda Accord, 1HGCM82633A004352, clean title", "vin", "1HGCM82633A004352");
  expectOnly("the dealer says 2T1BURHEXJC000001 has an open recall", "vin", "2T1BURHEXJC000001");
  expectOnly("insurance wants the number off the truck: 1FTFW1ET9DFC10312", "vin", "1FTFW1ET9DFC10312");
  expectOnly("¿Este coche tiene deudas? 4T1BF1FK0CU123456", "vin", "4T1BF1FK0CU123456");
  // A vehicle word wins over another code's label: "serial number" is what some people call their VIN
  expectOnly("the serial number on my truck is 1FTFW1ET9DFC10312", "vin", "1FTFW1ET9DFC10312");
});

// A VIN pasted on its own used to show nothing. It now counts with no label and no vehicle word nearby, as long as
// everything about it is right: 17 capitals and digits standing alone, at least 2 letters and 2 digits, the right
// check digit as the 9th character, a model year that exists as the 10th (never U, Z or 0), and four digits at
// the end.
test("VIN: on its own, when everything about it is right", () => {
  expectOnly("1HGCM82633A004352", "vin", "1HGCM82633A004352");
  expectOnly("  1HGCM82633A004352\n", "vin", "1HGCM82633A004352");
  expectOnly("what does 1HGCM82633A004352 mean in this spreadsheet?", "vin", "1HGCM82633A004352");
  expectOnly("What could 3VW0UTAT4SK484178 be in this column?", "vin", "3VW0UTAT4SK484178");
  expectOnly('can you decode "5YJ3E1EA2KF317000"?', "vin", "5YJ3E1EA2KF317000");
  expectOnly("is this right (1M8GDM9AXKP042788)?", "vin", "1M8GDM9AXKP042788");
  expectOnly("Here it is: 2T1BURHEXJC000001.", "vin", "2T1BURHEXJC000001");
  expectOnly("¿Qué significa 4T1BF1FK0CU123456?", "vin", "4T1BF1FK0CU123456");
  // A list or a spreadsheet's rows, pasted: a VIN's last digits and the year next to it aren't a phone number
  assert.deepEqual(detect("1HGCM82633A004352\t2003\n2T1BURHEXJC000001,2018\n"), {
    vin: ["1HGCM82633A004352", "2T1BURHEXJC000001"],
  });
  expectOnly("my car 1HGCM82633A004352 2003 Honda", "vin", "1HGCM82633A004352");
});

test("VIN on its own: quiet when anything about it is off", () => {
  expectNothing("1HGCM82643A004352"); // the check digit is wrong
  expectNothing("my car shows 1HGCM82643A004352 on the screen"); // wrong, even next to a vehicle word
  expectNothing("1HGCM8261UA004352"); // no model year is U
  expectNothing("1HGCM8262ZA004352"); // nor Z
  expectNothing("1HGCM82690A004352"); // nor 0
  expectNothing("1HGCM82633A00435B"); // a VIN ends in four digits
  expectNothing("40960318227154638"); // no letters: an order number, not a VIN
  expectNothing("the car forum post id is 1hgcm82633a004352"); // lower case without a label
  expectNothing("my Golf's WVWZZZ1JZXW000001"); // European, no check digit and no label
  expectNothing("car token ABCDEFGHJKLMNPRST expired"); // no digit
  // Inside something longer: a link, a file's name, a longer code, base64
  expectNothing("https://www.example.com/listing/1HGCM82633A004352");
  expectNothing("https://example.com/check?id=1HGCM82633A004352&lang=en");
  expectNothing("see example.com/1HGCM82633A004352 for the photos");
  expectNothing("1HGCM82633A004352.pdf");
  expectNothing("scan_1HGCM82633A004352.jpg");
  expectNothing("X1HGCM82633A004352");
  expectNothing("1HGCM82633A0043521");
  expectNothing("the blob is aGVsbG8+1HGCM82633A004352/d29ybGQ=");
  expectNothing("the vehicle part number is 52-1HGCM82633A004352-B");
  // Talk about VINs with no VIN in it
  expectNothing("The VIN is on the dashboard, where do I find it?");
  expectNothing("Vin Diesel drives a Dodge Charger in that movie");
  expectNothing("My car's VIN starts with 1HGCM, it's a 2008 Honda Accord");
  expectNothing("el chasis está oxidado, ¿vale la pena arreglarlo?");
  expectNothing("el número de serie de mi portátil es C02ZK1ZJMD6T4XYZ8");
});

// None of these made-up codes should warn, even though they look like a VIN. The ones marked "passes" even have
// the right check digit, a model year and four digits at the end, so only the label in front of them, like a
// tracking number, an order, a serial number or a build, tells them apart from a real VIN.
test("VIN on its own: tracking numbers, order codes, serials, keys, hashes, tokens and part numbers stay quiet", () => {
  for (const text of [
    // Tracking numbers
    "Where is my UPS package? 1Z8V46E20391847265",
    "FedEx tracking number 748930215568 says delivered",
    "USPS tracking 9400111899223197428490 hasn't moved in a week",
    "my Amazon package TBA304819264017 is late",
    "the DHL code is JD014600006281230704",
    "tracking number LK7W2P9R0M3416752", // passes
    "Tracking: LK7W2P9R0M3416752 (out for delivery)", // passes
    // Order, booking and confirmation codes
    "Order #112-4839201-5739124 never arrived",
    "Order W1849302751846293 was charged twice",
    "booking reference KX7P2Q, flight on Friday",
    "Your confirmation number is HX7B2K9P4M3R8T5W6",
    "order 9C4B71E00A8545316 shipped", // passes
    "Pedido 9C4B71E00A8545316: ¿cuándo llega?", // passes
    // Serial numbers and license keys
    "Serial number: C02ZK1ZJMD6T4XYZ8",
    "serial no. SER7KJ3M04L926815 on the router", // passes
    "Windows product key XKJ4N-8R2PT-WQ7MB-3HV9C-6YD2F",
    "license key 7KX2P9RT4M3WB8N6HJ5QF2D8A",
    // Hashes and tokens
    "fixed in commit 4f9c2a1",
    "git show 4f9c2a1b7e3d5f6a8",
    "build 4F9C2A1B5E3D50618 failed", // passes
    "the API returned id AB12CD34EF56GH789",
    "token 5CG2134X7KJ1L8M42 expired",
    // Part numbers
    "Part # 04465-33450-01 fits?",
    "PN 8W0615301AA in stock?",
  ])
    expectNothing(text);
});

// This measures how often a random code passes every rule for a VIN on its own, using a seeded generator so the
// numbers are the same every run. Over 2,000,000 codes each: capitals and digits pass about 1 in 19,600, the 33
// characters a VIN may use pass about 1 in 4,100, and capitals and digits from hex (0-9, A-F) pass about 1 in 124.
// That last one is why a code that a label calls something else still stays quiet. The bounds here are loose on
// purpose, so a rule that gets removed by mistake shows up at once.
test("VIN on its own: random 17-character codes almost never pass", () => {
  let a = 20261002;
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const passing = (set, count) => {
    let found = 0;
    for (let done = 0; done < count; done += 1000) {
      const codes = Array.from({ length: 1000 }, () =>
        Array.from({ length: 17 }, () => set[Math.floor(random() * set.length)]).join(""),
      );
      found += (detect(codes.join(" ")).vin || []).length;
    }
    return found;
  };
  const tries = 20000;
  const rates = {
    capitals: passing("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", tries),
    vinLetters: passing("ABCDEFGHJKLMNPRSTUVWXYZ0123456789", tries),
    hex: passing("0123456789ABCDEF", tries),
  };
  assert.ok(rates.capitals <= 5, `capitals and digits: ${rates.capitals} in ${tries}`);
  assert.ok(rates.vinLetters <= 15, `a VIN's own characters: ${rates.vinLetters} in ${tries}`);
  assert.ok(rates.hex <= 400, `hex: ${rates.hex} in ${tries}`);
});

test("VIN: the fingerprint ignores case, spaces and dashes; Hide it covers all of it", () => {
  const { fingerprint, redact } = globalThis.Clotr;
  const fp = fingerprint("s4lt", "vin", "1HGCM82633A004352");
  for (const m of ["1hgcm82633a004352", "1HG CM826 33A004352", "1HG-CM826-33A004352"])
    assert.equal(fingerprint("s4lt", "vin", m), fp, m);
  assert.notEqual(fingerprint("s4lt", "vin", "1HGCM82633A004353"), fp);
  const text = "my VIN is 1HGCM82633A004352, can you check it?";
  const hidden = redact(text, globalThis.Clotr.detect(text));
  assert.ok(!/1HG|4352/.test(hidden), hidden);
});

// A student ID counts right after a label, in English and Spanish. "Matrícula" means a student's number but also a
// car's plate in Spanish, so it only reads as a student's number when the value isn't plate-shaped and no vehicle
// word is nearby.
test("student ID after a label, in English and Spanish", () => {
  expectOnly("my student ID is 20481234", "student_id", "20481234");
  expectOnly("Student ID: S1234567", "student_id", "S1234567");
  expectOnly("student number A00123456, can you write to the registrar?", "student_id", "A00123456");
  expectOnly("my student no. 2048-1234 doesn't work on the portal", "student_id", "2048-1234");
  expectOnly("school ID #48213", "student_id", "48213");
  expectOnly("matric number 2216784", "student_id", "2216784");
  expectOnly("Mi número de estudiante es 20481234", "student_id", "20481234");
  expectOnly("carné de estudiante: A01234567", "student_id", "A01234567");
  expectOnly("mi matrícula es A01234567, ¿me ayudas con el correo?", "student_id", "A01234567");
  expectOnly("número de matrícula 2019630123", "student_id", "2019630123");
  // A vehicle word nearby, but the value can't be a plate (nine characters): still the student's number
  expectOnly("Para el seguro escolar piden la matrícula A01234567", "student_id", "A01234567");
});

test("student ID: quiet on 'student' in prose, course codes, class sizes, years and plates", () => {
  expectNothing("I'm a student at Ohio State and need help with CS 101");
  expectNothing("the student ID card office is closed until 9");
  expectNothing("our school has 1200 students and 85 teachers");
  expectNothing("Do I need my student ID for the 2026 exam?");
  expectNothing("my student ID 2026 sticker fell off");
  expectNothing("student ID 2025-26 renewal is open");
  expectNothing("student number 3 asked about the homework");
  expectNothing("student ID required for entry");
  expectNothing("La matrícula de la universidad cuesta 1.200 euros");
  expectNothing("el plazo de matrícula termina el 15 de septiembre");
  // A plate after "matrícula" is never a student's number
  for (const text of ["mi matrícula es 1234 BCD", "la matrícula del coche es 4821-KLM", "matrícula: ABC-123-D"])
    assert.equal(detect(text).student_id, undefined, text);
});

test("a student's number right after its label isn't a phone; a phone near student words still is", () => {
  expectOnly("student ID: 2015550123", "student_id", "2015550123");
  expectOnly("número de matrícula 2019630123", "student_id", "2019630123");
  expectOnly("I'm a student, my number is 555-555-0123", "phone_number", "555-555-0123");
  expectOnly("pagué la matrícula, mi número es 612 345 678", "phone_number", "612 345 678");
  assert.deepEqual(detect("my student ID is S1234567 and my phone is 555-555-0123"), {
    student_id: ["S1234567"],
    phone_number: ["555-555-0123"],
  });
});

// These are the ways people label a student's number. A bare number stays quiet on purpose, since it could be
// anything, so the label has to say what it is. Every number here is made up.
test("student ID: the common labels, in English and Spanish", () => {
  expectOnly("student no. 20481234", "student_id", "20481234");
  expectOnly("my school ID number is 20481234", "student_id", "20481234");
  expectOnly("mi matrícula es 20481234", "student_id", "20481234");
  expectOnly("mi número de estudiante es 20481234", "student_id", "20481234");
  // "SID", short for student ID at many universities: in capitals, before 7 to 10 digits
  expectOnly("SID 20481234", "student_id", "20481234");
  expectOnly("my SID is 20481234, can you write to the registrar?", "student_id", "20481234");
  expectOnly("SID: 2048123456", "student_id", "2048123456"); // ten digits, and not a phone
  expectOnly("SID #3049152", "student_id", "3049152");
  // A tech word, but the message is about school
  expectOnly("my SID is 20481234, can you check the session times for my class?", "student_id", "20481234");
  // Peru's and Colombia's "código de estudiante", and "ID de estudiante"
  expectOnly("mi código de estudiante es 20481234", "student_id", "20481234");
  expectOnly("código estudiantil: 2019630123", "student_id", "2019630123");
  expectOnly("código de alumno 20481234, ¿me ayudas con la carta?", "student_id", "20481234");
  expectOnly("mi ID de estudiante es A01234567", "student_id", "A01234567");
  // Still a bare number on its own: nothing
  expectNothing("20481234");
  expectNothing("my number is 2048123"); // seven digits, no label
});

test("student ID: quiet on a Windows security ID, SID in tech talk, and Sid the name", () => {
  expectNothing("S-1-5-21-3623811015-3361044348-30300820-1013");
  expectNothing("the SID S-1-5-21-3623811015-3361044348-30300820-1013 is the domain admin");
  expectNothing("whoami /user shows S-1-5-21-1004336348-1177238915-682003330-512");
  expectNothing("Oracle SID is ORCL, how do I change it?");
  expectNothing("SID 1234 in the session table"); // four digits
  expectNothing("PubChem SID 103164874 is the substance I need");
  expectNothing("kill session SID 2048123 in Oracle");
  expectNothing("the Windows SID 2048123456 of that user");
  // Split in two so secret scanners don't read this made-up ID as a real one; the test sees the same text.
  expectNothing("Twilio Account SID AC" + "2f8e3b1c9d7a6e5f4b3c2d1e0f9a8b7c");
  expectNothing("sid 20481234"); // lower case: a name or a session cookie, not a label
  expectNothing("SID=20481234"); // a cookie's or a link's value
  expectNothing("SID 2048-1234-5678"); // not a student's number's shape
  // Sid the person keeps his phone number
  expectOnly("call Sid at 555-555-0123", "phone_number", "555-555-0123");
});

// A license plate counts after a label: 2 to 8 letters and digits with at least one digit, in up to three groups.
// A plate starts as Just count, so it's counted quietly and nothing shows unless the person chooses to be warned.
test("license plates after a label, in English and Spanish", () => {
  expectOnly("my license plate is 7ABC123", "license_plate", "7ABC123");
  expectOnly("licence plate AB12 CDE, can you check the parking fine?", "license_plate", "AB12 CDE");
  expectOnly("number plate: AB12 CDE", "license_plate", "AB12 CDE");
  expectOnly("the plate number is ABC-1234", "license_plate", "ABC-1234");
  expectOnly("car reg AB12CDE", "license_plate", "AB12CDE");
  expectOnly("vehicle registration number AB12 CDE", "license_plate", "AB12 CDE");
  expectOnly("my rego is ABC123, when is it due?", "license_plate", "ABC123");
  expectOnly("reg plate ab12 cde", "license_plate", "ab12 cde");
  expectOnly("license plate ABC 1234 and the car is blue", "license_plate", "ABC 1234");
  expectOnly("Mis placas son ABC-123-D, ¿cómo pago la tenencia?", "license_plate", "ABC-123-D");
  expectOnly("número de placa ABC-1234", "license_plate", "ABC-1234");
  expectOnly("la patente del auto es AB 123 CD", "license_plate", "AB 123 CD");
  expectOnly("la matrícula del coche es 1234 BCD", "license_plate", "1234 BCD");
  expectOnly("mi matrícula es 1234 BCD", "license_plate", "1234 BCD"); // a Spanish plate's shape
  expectOnly("la matrícula 20481234 de mi coche nuevo", "license_plate", "20481234"); // a car word near
});

test("license plates: quiet on companies' registration numbers, vanity plates, fees and other plates", () => {
  expectNothing("company registration number 12345678");
  expectNothing("is the license plate HAPPY still available?");
  expectNothing("my rego is due 12 May, can I pay late?");
  expectNothing("the license plate reader at the garage failed");
  expectNothing("plate number 2024 renewal");
  expectNothing("I need a plate for 12 people");
  expectNothing("¿Qué placa base va con un Ryzen 7 7800X3D?");
  expectNothing("pon la placa de 30 cm en el horno");
  expectNothing("la patente 1234567 vence en 2030"); // a patent: a plate after "patente" has a letter
  expectNothing("Mis placas solares producen 4,5 kW");
});

test("license plates start as Just count; the fingerprint ignores case, spaces and dashes; Hide it covers them", () => {
  const { defaultResponse, fingerprint, redact } = globalThis.Clotr;
  assert.equal(defaultResponse("license_plate"), "log");
  const fp = fingerprint("s4lt", "license_plate", "AB12 CDE");
  for (const m of ["ab12 cde", "AB12CDE", "AB12-CDE"]) assert.equal(fingerprint("s4lt", "license_plate", m), fp, m);
  assert.notEqual(fingerprint("s4lt", "license_plate", "AB12 CDF"), fp);
  const text = "my licence plate is AB12 CDE, is that a London plate?";
  const hidden = redact(text, globalThis.Clotr.detect(text));
  assert.ok(!/AB12|CDE/.test(hidden), hidden);
  // A plate right after its label isn't read as a phone
  expectOnly("plate number 555 1234", "license_plate", "555 1234");
});

// What people write about their cars and schools. Every number is made up.
test("leak corpus: vehicles and school", () => {
  const cases = [
    ["vin", "my VIN is 1HGCM82633A004352, is there a recall?"],
    ["vin", "Can you decode this VIN: 1M8GDM9AXKP042788"],
    ["vin", "Selling my 2019 Toyota Camry, VIN 4T1BF1FK0CU123456, 60k miles, clean title. Write the ad."],
    ["vin", "Title says 5YJ3E1EA2KF317000 but the registration says something else, which is right?"],
    ["vin", "car insurance quote for 2T1BURHEXJC000001 please"],
    ["vin", "¿Me ayudas con el anuncio? Número de bastidor: VSSZZZ6JZ9R123456, 120.000 km."],
    ["student_id", "Write an email to my professor: I'm Sam, student ID 20481234, and I missed the midterm."],
    ["student_id", "my student number is S1234567 and the library says my card expired"],
    ["student_id", "Can you fill this in? Name: Alex, School ID: 48213, Grade: 7"],
    ["student_id", "Hola, mi número de alumno es 1984726 y no puedo entrar al aula virtual"],
    ["student_id", "Mi matrícula es A01234567, ¿cómo pido la constancia de estudios?"],
    ["license_plate", "Someone hit my car and drove off, their license plate was 7ABC123. What do I do now?"],
    ["license_plate", "Write an appeal for my parking fine, my number plate is AB12 CDE and I had a ticket."],
    ["license_plate", "my rego is ABC123 and I want to transfer it to my daughter"],
    ["license_plate", "Me pusieron una multa, mis placas son ABC-123-D. ¿Cómo la pago?"],
    ["license_plate", "La matrícula del coche es 1234 BCD, ¿cuándo me toca pasar la ITV?"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
});

// ---------- Gamer tags: the handle reader ----------
// A handle counts only right after a gaming-account label, because handles are everywhere in everyday chat: "add
// me on Discord", an "@name" in a pasted tweet, "my tag is". The kind starts as Just count, so it's counted quietly.
test("gamer tags after a gaming-account label, in English", () => {
  expectOnly("my gamertag is xXSniperXx", "gamer_tag", "xXSniperXx");
  expectOnly("Xbox gamertag: ShadowHunter42, add me!", "gamer_tag", "ShadowHunter42");
  expectOnly("my gamer tag's Dark_Knight_7", "gamer_tag", "Dark_Knight_7");
  expectOnly("gamertag xXSniperXx, I'm on after 8", "gamer_tag", "xXSniperXx");
  expectOnly("my BattleTag is Player#1234", "gamer_tag", "Player#1234");
  expectOnly("Riot ID: Hide on bush#KR1", "gamer_tag", "Hide on bush#KR1"); // Riot names may have spaces
  expectOnly("my Riot ID is Faker#KR1, can you check my rank?", "gamer_tag", "Faker#KR1");
  expectOnly("my son's Roblox username is cool_kid_2014, is that safe?", "gamer_tag", "cool_kid_2014");
  expectOnly("Minecraft username: Steve.Builder", "gamer_tag", "Steve.Builder");
  expectOnly("my Steam ID is 76561198012345678", "gamer_tag", "76561198012345678");
  expectOnly("PSN ID: xX_Ghost_Xx", "gamer_tag", "xX_Ghost_Xx");
  expectOnly("my PlayStation username is ghost.rider.99.", "gamer_tag", "ghost.rider.99");
  expectOnly("my Epic Games name is NinjaTurtle", "gamer_tag", "NinjaTurtle");
  expectOnly("my Discord username is luna.moon", "gamer_tag", "luna.moon");
  expectOnly("my Fortnite name is shadowfox", "gamer_tag", "shadowfox"); // a plain word after "is", not an everyday one
  expectOnly("my IGN is Shroud", "gamer_tag", "Shroud");
  expectOnly("my in-game name is Kira", "gamer_tag", "Kira");
  expectOnly("my summoner name is Doublelift", "gamer_tag", "Doublelift");
  expectOnly("my username on Roblox is pepito_2012", "gamer_tag", "pepito_2012");
  expectOnly("my gamertag on Xbox is Kn1ghtRider", "gamer_tag", "Kn1ghtRider");
  expectOnly('my gamertag is "Shadow"', "gamer_tag", "Shadow");
  expectOnly("my gamertag is now ShadowFox99", "gamer_tag", "ShadowFox99");
  expectOnly("my gamertag was xXSniperXx before I changed it", "gamer_tag", "xXSniperXx");
  expectOnly("my Discord username is @luna.moon", "gamer_tag", "luna.moon");
  expectOnly("my Steam ID is STEAM_0:1:12345678", "gamer_tag", "STEAM_0:1:12345678");
  expectOnly("my Switch friend code is SW-1234-5678-9012", "gamer_tag", "SW-1234-5678-9012");
  expectOnly("my Pokemon GO friend code is 1234 5678 9012", "gamer_tag", "1234 5678 9012");
});

test("gamer tags after a gaming-account label, in Spanish", () => {
  expectOnly("mi usuario de Roblox es pepito_2012", "gamer_tag", "pepito_2012");
  expectOnly("Mi nombre de usuario en Steam es lobo_feroz", "gamer_tag", "lobo_feroz");
  expectOnly("mi gamertag es ElTigre77", "gamer_tag", "ElTigre77");
  expectOnly("mi ID de Riot es Faker#KR1", "gamer_tag", "Faker#KR1");
  expectOnly("mi nick en Minecraft es CreeperKing", "gamer_tag", "CreeperKing");
  expectOnly("¿Me ayudas? Mi nombre en Fortnite es lobito", "gamer_tag", "lobito");
  expectOnly("mi código de amigo es SW-1234-5678-9012", "gamer_tag", "SW-1234-5678-9012");
  expectOnly("usuario de Xbox: Kn1ghtRider", "gamer_tag", "Kn1ghtRider");
  expectOnly("Mi usuario de Roblox es galletita y quiero cambiarlo", "gamer_tag", "galletita");
});

test("gamer tags: quiet without a gaming label, on everyday words after one, and on games talk", () => {
  // Handles without a gaming-account label
  expectNothing("add me on Discord, I'm on most evenings");
  expectNothing("Look what @xXSniperXx tweeted about the update: wow");
  expectNothing("my tag is on the inside of the shirt collar");
  expectNothing("my username is bob_99 and I can't log in to the bank");
  expectNothing("follow me @luna.moon on Instagram");
  // Everyday words after a label
  expectNothing("my gamertag is private");
  expectNothing("my gamertag is too long, can you suggest a shorter one?");
  expectNothing("my gamertag and my Discord name are different");
  expectNothing("my Steam name is the same as my Xbox gamertag");
  expectNothing("my Xbox gamertag is so embarrassing, help me pick a new one");
  expectNothing("my Fortnite name is kinda cringe lol");
  expectNothing("my PSN ID is linked to my old email");
  expectNothing("my Riot ID was banned for no reason");
  expectNothing("my gamertag is literally my name");
  expectNothing("my Discord username is case-sensitive?");
  expectNothing("my gamertag is 2 years old");
  expectNothing("my gamertag is 1.5 years old and I want a new one");
  expectNothing("my gamertag is 2nd on the leaderboard");
  expectNothing("My Riot ID was reset after the update and my friends can't find me.");
  expectNothing("My gamertag is just numbers, is that weird?");
  expectNothing("My gamertag is red in the party list, why?");
  // A plain word counts only in someone's label: these are about the game, not a player
  expectNothing("The Xbox name is Microsoft's, not Sony's.");
  expectNothing("The name on Steam is Hollow Knight, but on Switch it has a subtitle.");
  expectNothing("El nombre en Steam es Hollow Knight, pero en Switch tiene subtítulo.");
  // Talk about games, names and codes
  expectNothing("What's a good gamertag for a Fortnite player?");
  expectNothing("Roblox username ideas for a girl who likes cats");
  expectNothing("Is my gamertag visible to everyone?");
  expectNothing("IGN gave the new Zelda a 9, is it worth it?");
  expectNothing("IGN: the review says the combat is great");
  expectNothing("the Roblox ID for the song is 1837070127");
  expectNothing("use my friend code ABC123 for $10 off your first order");
  expectNothing("the BattleTag change costs $10, is it worth it?");
  expectNothing("the epic name of the hero is Beowulf");
  expectNothing("Steam tag: Roguelike, what games have it?");
  expectOnly("my Steam username is bob@example.com", "email", "bob@example.com"); // an email, not also a tag
  // Spanish
  expectNothing("agrégame en Discord cuando puedas");
  expectNothing("mi usuario de Roblox es privado");
  expectNothing("mi gamertag es el mismo que en Xbox");
  expectNothing("¿Cuál es un buen nombre de usuario para Minecraft?");
  expectNothing("mi nombre en Fortnite es muy largo, ¿me das ideas?");
});

test("gamer tags start as Just count; the fingerprint ignores case; Hide it covers the whole tag", () => {
  const { defaultResponse, fingerprint, redact } = globalThis.Clotr;
  assert.equal(defaultResponse("gamer_tag"), "log");
  const fp = fingerprint("s4lt", "gamer_tag", "xXSniperXx");
  for (const m of ["xxsniperxx", "XXSNIPERXX"]) assert.equal(fingerprint("s4lt", "gamer_tag", m), fp, m);
  assert.notEqual(fingerprint("s4lt", "gamer_tag", "xXSniperXy"), fp);
  assert.equal(
    fingerprint("s4lt", "gamer_tag", "hide on  bush#kr1"),
    fingerprint("s4lt", "gamer_tag", "Hide on bush#KR1"),
  );
  for (const text of ["my Riot ID is Hide on bush#KR1, help me climb", "my gamertag is xXSniperXx, add me"]) {
    const hidden = redact(text, globalThis.Clotr.detect(text));
    assert.ok(!/bush|KR1|Sniper/.test(hidden), hidden);
  }
});

// What people write about their games. Every handle is made up.
test("leak corpus: gamer tags", () => {
  const cases = [
    "My son's Roblox username is cool_kid_2014. Is that safe, or should he change it?",
    "Write a short bio for my Twitch page. My Xbox gamertag is ShadowHunter42 and I mostly play Halo.",
    "Can you check my Valorant rank? Riot ID: Hide on bush#KR1",
    "I lost access to my account, my BattleTag is Player#1234 and the email is old",
    "my Steam ID is 76561198012345678, why can't my friends see my games?",
    "Mi usuario de Roblox es pepito_2012 y alguien me pide la contraseña, ¿qué hago?",
    "mi gamertag es ElTigre77, ¿cómo lo cambio sin pagar?",
  ];
  const missed = cases.filter((text) => !detect(text).gamer_tag).map((text) => text.slice(0, 60));
  assert.deepEqual(missed, []);
});

test("gamer tags: the handle reader stays fast on hostile text", () => {
  const p = globalThis.Clotr.PATTERNS.find((x) => x.id === "gamer_tag");
  assert.ok(p, "no gamer_tag kind");
  assertLinear(
    p.find,
    (u, n) => u.repeat(n),
    ["gamertag ", "gamertag is a", "Riot ID a ", "a#1 ", "my IGN is ", "friend code 1234 ", "usuario de Roblox es a_"],
    20000,
  );
  assertLinear(p.find, (u, n) => "my gamertag is " + u.repeat(n), ["a", "a.", "a-", "a ", "a#", "1:", "_"], 20000);
});

test("spoken numbers with hundred and thousand", () => {
  expectOnly("call me at five five five, five hundred fifty five, twelve thirty four", "phone_number");
  expectOnly("my cell is five five five five hundred and five one two three four", "phone_number");
  expectOnly("phone: five five five, eight hundred, fifty six thirty six", "phone_number");
  expectOnly("SSN one two three, forty five, six thousand seven hundred eighty nine", "us_ssn");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("five five five, five hundred fifty five, twelve thirty four"), fp("555-555-1234"));
  // "double five" = 55, "triple seven" = 777, as numbers are often read out
  expectOnly("ring me on five five five, double five five, one two three four", "phone_number");
  expectOnly("my number is 555 triple 5 double 1 two three", "phone_number");
  assert.equal(fp("five five five, double five five, one two three four"), fp("555-555-1234"));
  expectNothing("I got a double espresso and a triple shot at five");
  // Amounts and years stay quiet
  expectNothing("it cost five hundred dollars and took two thousand hours");
  expectNothing("a hundred people came, maybe a thousand");
  expectNothing("in nineteen hundred and five the town had six hundred homes");
});

test("more disguises: teens/tens, letters for digits, sound-alike words", () => {
  expectOnly("call five five five, five fifty five, fifty six thirty six", "phone_number");
  expectOnly("my number is five five five five five five fifty six thirty six", "phone_number");
  expectOnly("555-555-O636", "phone_number", "555-555-O636");
  expectOnly("55555556l6", "phone_number", "55555556l6");
  expectOnly("five five five five five five won two three four", "phone_number"); // sound-alikes only count between digits
  expectOnly("social one two three, forty five, sixty seven eighty nine", "us_ssn");
  // The same number gets the same fingerprint no matter how it's disguised.
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("five five five, five fifty five, fifty six thirty six"), fp("555-555-5636"));
  assert.equal(fp("555-555-O636"), fp("555-555-0636"));
  // Everyday words stay words
  expectNothing("I want to go for a walk at 5 to 6");
  expectNothing("we won 2 to 1 and ate for free");
  expectNothing("Ohio has 88 counties and hello world");
  expectNothing("sixty seven people from Ohio");
  expectNothing("twenty twenty four was a good year");
});

test("international phone numbers (+, plus, 00)", () => {
  expectOnly("London office: +44 20 7946 0958", "phone_number", "+44 20 7946 0958");
  expectOnly("call +91 98765 43210 anytime", "phone_number", "+91 98765 43210");
  expectOnly("0044 20 7946 0958", "phone_number", "0044 20 7946 0958");
  expectOnly("+33 1 23 45 67 89", "phone_number", "+33 1 23 45 67 89");
  expectOnly("+44 (0)20 7946 0958", "phone_number", "+44 (0)20 7946 0958");
  expectOnly("plus four four two zero seven nine four six zero nine five eight", "phone_number");
  expectOnly("+1 555 555 5636", "phone_number", "+1 555 555 5636");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("0044 20 7946 0958"), fp("+44 20 7946 0958"));
  assert.equal(fp("+44 (0)20 7946 0958"), fp("+44 20 7946 0958"));
  expectNothing("the score went from +3 to +7");
  expectNothing("that's 2 plus 3 plus 15");
  expectNothing("code 00100 is fine");
});

// A drug's National Drug Code after "NDC" isn't a phone number. Its shapes are 4-4-2, 5-3-2 and 5-4-1, or 5-4-2
// as 11 digits.
test("a drug's NDC code isn't a phone number; a phone near it, or another shape after NDC, still is", () => {
  expectNone("How do I look up which drug NDC 0093-7146-56 is? The bottle just says the generic name.");
  expectNone("NDC 50580-488-02 is the one in the blue box");
  expectNone("the NDC is 00093-7146-56, what is it?");
  expectNone("NDC #: 0002-3227-30");
  expectNone("NDC code 12345-6789-1");
  expectNone("NDC: 5058048802");
  expectNone("¿Qué medicamento es el NDC 50580-488-02?");
  // still phones
  expectOnly("NDC 0093-7146-56, call me at 555-555-0142", "phone_number", "555-555-0142");
  expectOnly("my NDC question: call 0044 20 7946 0958", "phone_number", "0044 20 7946 0958");
  expectOnly("NDC 555-555-0142", "phone_number", "555-555-0142");
  expectOnly("call 0093 7146 5600 about the NDC", "phone_number");
});

test("vault names match with or without accents; entries saved before still match", () => {
  const C = globalThis.Clotr;
  const salt = "s4lt";
  C.setVault({
    salt,
    entries: [
      { kind: "word", type: "my_name", fp: C.fingerprint(salt, "watch_list", "José García"), words: 2 },
      // An entry saved by an older version: its fingerprint kept the accents.
      { kind: "word", type: "family_name", fp: C.fingerprint(salt, "watch_list_accented", "Íñigo"), words: 1 },
    ],
  });
  try {
    expectOnly("soy Jose Garcia", "my_name", "Jose Garcia");
    expectOnly("soy josé garcía", "my_name", "josé garcía");
    expectOnly("mi hijo Íñigo tiene fiebre", "family_name", "Íñigo");
    assert.equal(C.fingerprint(salt, "watch_list", "José"), C.fingerprint(salt, "watch_list", "jose"));
    assert.equal(C.fingerprint(salt, "my_name", "José García"), C.fingerprint(salt, "my_name", "jose  garcia")); // history and reply check
  } finally {
    C.setVault(null);
  }
});

test("vault: your words by category (fingerprinted) and ID formats", () => {
  const C = globalThis.Clotr;
  const salt = "s4lt";
  const word = (type, w) => ({
    kind: "word",
    type,
    fp: C.fingerprint(salt, "watch_list", w),
    words: w.split(" ").length,
  });
  C.setVault({
    salt,
    entries: [
      word("watch_list", "Project Falcon"),
      word("watch_list", "Acme"),
      word("my_name", "Jane Q Doe"),
      word("family_name", "Emma"),
      word("employer", "Initech"),
      { kind: "shape", type: "watch_list", shape: "EMP-#####" },
      { kind: "shape", type: "my_id", shape: "@@-####" },
      { kind: "value", type: "phone_number", fp: "ffffffffffffffff", mode: "protect" }, // values: handled by content.js
    ],
  });
  expectOnly("status of project   FALCON please", "watch_list", "project   FALCON");
  expectOnly("the Acme renewal", "watch_list", "Acme");
  expectOnly("ticket for EMP-12345 today", "watch_list", "EMP-12345");
  expectOnly("ref AB-1234 ok", "my_id", "AB-1234");
  expectOnly("hi, I'm jane q doe", "my_name", "jane q doe");
  expectOnly("Emma has a fever", "family_name", "Emma");
  expectOnly("it's Emma's birthday", "family_name", "Emma"); // possessive: just the name
  expectOnly("Emma’s school", "family_name", "Emma");
  expectOnly("I work at Initech.", "employer", "Initech");
  expectNothing("the falcon flew over the project");
  expectNothing("EMP-1234 has four digits");
  expectNothing("acmes are not acme-like"); // whole words only
  C.setVault(null);
  expectNothing("status of project falcon");
});

// A team's own kinds come from its browser policy, so they can't live in the static PATTERNS table. setVault takes
// them in with the vault, and detect() checks them like any other kind.
const MATTER = { id: "team_matter_number", name: "Matter number", cover: "Matter" };
const CLIENT = { id: "team_client_name", name: "Client name", cover: "Client" };

test("kinds added at run time: found by words and formats under their own name, gone when setVault has none", () => {
  const C = globalThis.Clotr;
  const salt = "s4lt";
  C.setVault({
    salt,
    kinds: [MATTER, CLIENT],
    entries: [
      { kind: "shape", type: "team_matter_number", shape: "MAT-######" },
      { kind: "word", type: "team_client_name", fp: C.fingerprint(salt, "watch_list", "Globex Corp"), words: 2 },
    ],
  });
  try {
    const found = Object.fromEntries(
      C.detect("re MAT-204141 for Globex  corp, call 555-555-0147").map((r) => [r.id, r]),
    );
    assert.deepEqual(Object.keys(found).sort(), ["phone_number", "team_client_name", "team_matter_number"]);
    assert.deepEqual(found.team_matter_number.matches, ["MAT-204141"]);
    assert.deepEqual(found.team_client_name.matches, ["Globex  corp"]);
    const { name, severity, group, team, cover } = found.team_matter_number;
    assert.deepEqual(
      { name, severity, group, team, cover },
      {
        name: "Matter number",
        severity: "medium",
        group: "custom",
        team: true,
        cover: "Matter",
      },
    );
    assert.deepEqual(
      C.vaultKinds().map((k) => k.id),
      ["team_matter_number", "team_client_name"],
    );
    expectNothing("MAT-20414 has five digits, and globex alone isn't the client");
    // The static table never changes: other pages (the popup, the report summary) see built-in kinds only.
    assert.ok(!C.PATTERNS.some((p) => p.id.startsWith("team_")));
    // A kind with nothing to look for is known, and quiet.
    C.setVault({ salt, kinds: [MATTER], entries: [] });
    assert.deepEqual(
      C.vaultKinds().map((k) => k.id),
      ["team_matter_number"],
    );
    expectNothing("re MAT-204141");
  } finally {
    C.setVault(null);
  }
  expectNothing("re MAT-204141 for globex corp");
  assert.deepEqual(C.vaultKinds(), []);
});

test("kinds added at run time: a built-in, malformed or repeated id is refused, and names are bounded", () => {
  const C = globalThis.Clotr;
  C.setVault({
    salt: "s",
    kinds: [
      { id: "phone_number", name: "Not a phone" }, // a built-in kind can't be replaced
      { id: "Team-Matter", name: "Bad id" },
      { id: "team_9", name: "Digits" },
      { id: "x".repeat(41), name: "Too long" },
      { id: "team_ok", name: "" }, // no name to show
      { id: "team_ok", name: "x".repeat(200), cover: "y".repeat(200) },
      { id: "team_ok", name: "Again" },
      null,
      "team_str",
    ],
    entries: [{ kind: "shape", type: "team_9", shape: "MAT-######" }],
  });
  try {
    const kinds = C.vaultKinds();
    assert.deepEqual(
      kinds.map((k) => k.id),
      ["team_ok"],
    );
    assert.ok(kinds[0].name.length <= 40 && kinds[0].cover.length <= 20, "name and cover are cut to size");
    expectNothing("re MAT-204141"); // a refused kind's format finds nothing
  } finally {
    C.setVault(null);
  }
});

test("a format with nearby words counts only when one of them is within 40 characters before it", () => {
  const C = globalThis.Clotr;
  C.setVault({
    salt: "s",
    kinds: [{ id: "team_case_code", name: "Case code", cover: "Case" }],
    entries: [{ kind: "shape", type: "team_case_code", shape: "@@-####", near: ["case", "número de expediente"] }],
  });
  const found = (text) => C.detect(text).find((r) => r.id === "team_case_code")?.matches || [];
  try {
    assert.deepEqual(found("case AB-1234"), ["AB-1234"]);
    assert.deepEqual(found("Case no. AB-1234 is open"), ["AB-1234"]);
    assert.deepEqual(found("CASE: ab-1234"), ["ab-1234"]);
    assert.deepEqual(found("el numero de expediente es CD-5678"), ["CD-5678"]); // accents don't matter
    assert.deepEqual(found("the case, then a long aside of some words, AB-1234"), ["AB-1234"]); // starts 39 before
    assert.deepEqual(found("the case, then a much longer aside of words: AB-1234"), []); // starts 41 before
    assert.deepEqual(found("AB-1234 is the case"), [], "after it doesn't count");
    assert.deepEqual(found("my suitcase AB-1234"), [], "inside another word doesn't count");
    assert.deepEqual(found("cases AB-1234"), [], "a longer word doesn't count");
    assert.deepEqual(found("flight AB-1234"), []);
    // The same text twice: only the one with a nearby word is found.
    assert.deepEqual(found("flight EF-1111, case GH-2222"), ["GH-2222"]);
  } finally {
    C.setVault(null);
  }
});

// A team writes its own formats, so they're attacker-shaped input as far as the matcher is concerned. No regex
// ever comes straight from a policy: a format only becomes a pattern through shapeToRegExp, which allows literal
// characters and one digit or letter class per mark, no repeats and no choices, up to 40 characters. That keeps
// matching linear.
test("formats a team supplies stay bounded: matched literally, never as a regex; too long refused; linear", () => {
  const C = globalThis.Clotr;
  const kind = { id: "team_x", name: "X", cover: "X" };
  C.setVault({
    salt: "s",
    kinds: [kind],
    entries: [
      { kind: "shape", type: "team_x", shape: "(a+)+$-####" },
      { kind: "shape", type: "team_x", shape: ".*@@@@" },
      { kind: "shape", type: "team_x", shape: "@".repeat(41) },
      { kind: "shape", type: "team_x", shape: "@@@@-##", near: ["(.*)+", "x".repeat(41)] },
    ],
  });
  const found = (text) => C.detect(text).find((r) => r.id === "team_x")?.matches || [];
  try {
    assert.deepEqual(found("ref (a+)+$-1234"), ["(a+)+$-1234"]);
    assert.deepEqual(found("ref aaaa-1234 and xx-1234"), [], "a format's characters are never regex syntax");
    assert.deepEqual(found("ref .*abcd"), [".*abcd"]);
    assert.deepEqual(found("ref zzzz"), []);
    assert.deepEqual(found(`ref ${"a".repeat(41)}`), [], "a format over 40 characters is refused");
    assert.deepEqual(found("(.*)+ ABCD-12"), ["ABCD-12"], "nearby words are plain words, never regex syntax");
    assert.deepEqual(found("anything ABCD-12"), []);
  } finally {
    C.setVault(null);
  }

  // 50 formats is every team's limit. These are built to make a matcher work as hard as it can: long runs of one
  // punctuation mark, or a mark and a separator taken in turn, which pass the word-edge check at almost every
  // position.
  const seps = [".", " ", "/", ":", "(", ")", "*", "+", "?", "|", "[", "{", "$", "^", ","];
  const formats = Array.from({ length: 50 }, (_, i) =>
    i % 2
      ? seps[i % seps.length].repeat(36 - (i % 5)) + "#@"[(i % 4) >> 1].repeat(4)
      : ("@#"[(i % 4) >> 1] + seps[i % seps.length]).repeat(20).slice(0, 40 - (i % 3)),
  );
  C.setVault({
    salt: "s",
    kinds: [kind],
    entries: formats.map((shape, i) => ({
      kind: "shape",
      type: "team_x",
      shape,
      ...(i % 3 ? {} : { near: ["case"] }),
    })),
  });
  // Each run gets its own text (one more space at the end), so the vault's once-per-text answer can't hide the work.
  let runs = 0;
  try {
    assertLinear(
      (text) => C.detect(text + " ".repeat(++runs % 7)),
      (u, n) => u.repeat(n),
      [".", " ", "/ ", "(.", "a.", "a ", "1 ", "case ", "MAT-"],
      5000,
    );
  } finally {
    C.setVault(null);
  }
});

test("addresses normalize: St = Street, words = digits, case and punctuation ignored", () => {
  const fp = (m) => globalThis.Clotr.fingerprint("s", "street_address", m);
  const want = fp("123 Oak Street");
  for (const m of [
    "123 oak st.",
    "123 Oak St, Springfield, IL 62704",
    "one twenty three Oak Street Apt 4",
    "123 OAK STREET",
  ]) {
    assert.equal(fp(m), want, m);
  }
  assert.equal(fp("77 W. 5th Ave"), fp("77 west 5th avenue"));
  assert.notEqual(fp("125 Oak Street"), want);
  assert.notEqual(fp("123 Oak Road"), want);
  assert.equal(fp("P.O. Box 55"), fp("po box 55, Dayton, OH 45402"));
});

test("connection strings, JWTs, .env files, internal IPs and hosts", () => {
  expectOnly(
    "DATABASE_URL is postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
    "connection_string",
    "postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
  );
  expectOnly("mongodb+srv://app:hunter2x@cluster0.ab1cd.mongodb.net/test", "connection_string");
  expectNothing("format: postgres://user:password@localhost/db");
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MjQyIiwibmFtZSI6IkphbmUifQ.Xk3v9Qm2Lr7Tz5Wn8Bc1Hy4Jg6Df0SaPq";
  expectOnly(`token ${jwt}`, "jwt", jwt);
  const env = "DB_HOST=localhost\nDB_PASSWORD=Pr0dPassw0rd!\nSTRIPE_WEBHOOK_SECRET_KEY=whsec_9f8e7d6c5b4a\nPORT=3000";
  assert.deepEqual(detect(env), { password: ["Pr0dPassw0rd!", "whsec_9f8e7d6c5b4a"] });
  expectOnly("the server is 10.0.4.21 now", "internal_ip", "10.0.4.21");
  expectOnly("router at 192.168.1.1", "internal_ip", "192.168.1.1");
  expectOnly("docker gave it 172.20.0.5", "internal_ip", "172.20.0.5");
  expectNothing("public DNS 8.8.8.8 and 172.32.0.1");
  expectNothing("version 10.2.3 and build 10.0.19041.1");
  expectOnly("ssh into build-01.corp tonight", "internal_host", "build-01.corp");
  expectOnly("print to printer.local", "internal_host", "printer.local");
  expectOnly("call api.internal/v1", "internal_host", "api.internal");
  expectNothing("the local news and internal memo");
});

// Detection runs on every pause in typing and again on Enter, so it has to stay fast on long drafts and big
// pastes. The budgets here are generous, to allow for slow CI machines; the bug they guard against took 850 ms for
// 20,000 characters and 4 seconds for 40,000.
test("detection stays fast on long drafts and big pastes (no quadratic patterns)", () => {
  const prose = "I was thinking about the project plan for next week and how to structure the meeting. ";
  const inputs = {
    "long prose": prose.repeat(2300),
    "spelled-out numbers": "one two three four five six seven eight nine ten ".repeat(800),
    "number words and streets": "twenty one forty two main street and ninety nine ".repeat(800),
    "csv paste": Array.from({ length: 2000 }, (_, i) => `Person ${i},p${i}@example.com,555-555-${1000 + i}`).join("\n"),
    digits: "1234567890 ".repeat(4000),
  };
  for (const [name, text] of Object.entries(inputs)) {
    // This takes the best of 3, like the other speed checks, so one garbage-collection pause on a busy CI runner
    // doesn't read as the detector being slow. A run that takes 80 ms locally once took 422 ms on CI.
    retrySlow(() => {
      const t = bestOfBoth(() => globalThis.Clotr.detect(text));
      if (t.over(400))
        return `${name} (${text.length} chars) took ${t.wall.toFixed(0)} ms (${t.cpu.toFixed(0)} of processor, ${t.allowed.toFixed(0)} allowed on this computer now)`;
    });
  }
});

// A wall-clock timing couldn't tell this apart from noise. The pairwise bug's extra iterations are so cheap, just a
// length check with no string search, that even at 8,000 lines they add only a little wall time next to everything
// else detect() does on that much text. On a busy 22-core machine the run-to-run noise on the clock alone was wider
// than the real gap between linear and pairwise growth, however many of the slowest-of-several timings were tried.
// Counting how many candidates the overlap check actually looks at has no such noise instead: it's a counter in
// detector.js that detect() resets on every call, and linear growth comes out as exactly n, pairwise as exactly n²
// (1,000 and 1,000,000 here).
test("a paste with thousands of different details scans in linear time (overlap check isn't pairwise)", () => {
  const csv = (n) =>
    Array.from(
      { length: n },
      (_, i) => `Person ${i},p${i}@example.com,555-555-${String(1000 + (i % 9000)).padStart(4, "0")}`,
    ).join("\n");
  globalThis.Clotr.detect(csv(1000));
  const small = globalThis.Clotr.overlapChecks;
  globalThis.Clotr.detect(csv(8000));
  const big = globalThis.Clotr.overlapChecks;
  // 8 times the lines should mean about 8 times the candidates on this check. The limit of 20 times leaves room
  // without reaching the 64 times a pairwise scan would give.
  assert.ok(big / small < 20, `1,000 → 8,000 lines: ${small} → ${big} overlap checks`);
});

test("home coordinates are an address; other places are not", () => {
  expectOnly("my home is at 40.712776, -74.005974", "street_address", "40.712776, -74.005974");
  expectOnly("my house GPS: 51.5007° N, 0.1246° W", "street_address", "51.5007° N, 0.1246° W");
  expectOnly("mi casa está en 40.4168, -3.7038", "street_address", "40.4168, -3.7038");
  expectNothing("what restaurants are near 40.7128,-74.0060?");
  expectNothing("The Eiffel Tower is at 48.8584, 2.2945");
  expectNothing("my home is about 40.7 miles from work");
});

// A message with many details, one per line, should find each of them. A pattern must never run on from one line
// into the next and hide what's written there; an address after a ZIP code once did exactly that.
test("many details on separate lines are each found", () => {
  const LINES = [
    "call me at 555-555-5636",
    "my number is five five five five five five five six three six",
    "ring me on 07700 900123",
    "+44 20 7946 0958",
    "my social is 219-09-9999",
    "social security two one nine dash oh nine dash nine nine nine nine",
    "jane.doe@example.com",
    "my email is bob at gmail dot com",
    "email me at bob at gmial dot com",
    "I live at 123 Main St, Springfield, IL 62704",
    "one twenty three main street apt 4",
    "vivo en Calle Mayor 5, Madrid",
    "my home is at 40.712776, -74.005974",
    "I was born on 3/14/1948",
    "nací el 14 de marzo de 1962",
    "4111 1111 1111 1111",
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "account number is 123456789012",
    "routing: 021000021",
    "IBAN DE89 3704 0044 0532 0130 00",
    "mi DNI es 12345678Z",
    "CURP: GODE561231HDFRRN00",
    "my ITIN is 912-70-1234",
    "my NHS number is 943 476 5919",
    "my aadhaar is 2345 6789 0124",
    "my medicare number is 1EG4-TE5-MK73",
    "my password is Fluffy123",
    "the gate code is 1234",
    "the CVV is 123",
    "the AnyDesk code is 123 456 789",
    "my mother's maiden name is Smith",
    "my google backup codes are 1234 5678, 2345 6789",
    "Cookie: sessionid=8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s; theme=dark",
    "password = correct horse battery staple",
    "key AKIA4HPQ7XZ2R6TWLJ3N here",
    "ghp_" + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi",
    "postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
    "the server is 10.0.4.21 now",
    // Spanish
    "mi móvil es 612 345 678",
    "llámame al seis cero cero, doce, treinta y cuatro, cincuenta y seis",
    "el pin de la tarjeta 4821",
    "NSS: 281234567840",
    "RFC: PEPJ800101AB3",
    "vivo en calle mayor 5, madrid",
    "el código de AnyDesk es 123 456 789",
    "mi correo es juan arroba gmail punto com",
    "nací el 14 de marzo de 1962",
    "la contraseña es gato azul pizza fría.",
    "mis códigos de respaldo son 1234 5678, 2345 6789",
    "el CVV es 123",
    "mi casa está en 40.4168, -3.7038",
  ];
  const each = LINES.map((line) => detect(line));
  const missing = [];
  for (const order of ["forward", "reversed"]) {
    // what comes before a line matters too
    const all = detect((order === "forward" ? LINES : [...LINES].reverse()).join("\n"));
    each.forEach((found, i) => {
      for (const [id, matches] of Object.entries(found)) {
        for (const m of matches)
          if (
            !Object.values(all)
              .flat()
              .some((x) => x.includes(m))
          )
            missing.push(`${order}: ${LINES[i]} → ${id}: ${m}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});

// Hide it must leave nothing of the detail behind. A match that covers only part of it, like
// "doe(at)gmail(dot)com" without the "jane(dot)" before it, still shows who someone is. Each line below is one
// detail plus ordinary words.
test("Hide it leaves no part of a detail behind", () => {
  const { detect: find, redact } = globalThis.Clotr;
  const WORD =
    "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)";
  const LEFT = new RegExp(
    String.raw`\d{3}|\b${WORD}\b(?:[\s,-]+\b${WORD}\b){2}|@|\(at\)|\b(?:dot|arroba|punto)\b`,
    "i",
  );
  const DETAILS = [
    "call me at five five five, five five five, five six three six please",
    "my social is two one nine dash oh nine dash nine nine nine nine",
    "contact: jane(dot)doe(at)gmail(dot)com thanks",
    "mi correo es juan punto perez arroba hotmail punto es gracias",
    "email me at bob at gmial dot com",
    "write to jane dot doe at gmail dot com",
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "1. 555-555-5636",
    "my number is 555-555-5636x12",
    "+44 20 7946 0958 is the office",
    "ring me on 07700 900123 today",
    "my google backup codes are 1234 5678, 2345 6789",
    "my bitlocker recovery key is 123456-234567-345678-456789-567890",
    "the AnyDesk code is 123 456 789 ok",
    "mi DNI es 12345678Z",
    "my ITIN is 912-70-1234",
    "llámame al seis cero cero, doce, treinta y cuatro, cincuenta y seis",
    "my number is five five five five hundred fifty five, twelve thirty four",
    "phone # 5555555636",
  ];
  const left = [];
  for (const line of DETAILS) {
    const covered = redact(line, find(line));
    if (LEFT.test(covered.replace(/\[REDACTED [^\]]*\]/g, ""))) left.push(`${line} → ${covered}`);
    // …and the hidden message is quiet: the warning doesn't come back, and the labels trigger nothing.
    else if (find(covered).length) left.push(`${line} → still found in "${covered}"`);
  }
  assert.deepEqual(left, []);
});

test("spelled-out house numbers up to six words are still addresses", () => {
  // An address on the next line is found too (a match used to run on from the ZIP code above).
  assert.deepEqual(
    detect("I live at 123 Main St, Springfield, IL 62704\none twenty three main street apt 4").street_address,
    ["123 Main St, Springfield, IL 62704", "one twenty three main street apt 4"],
  );
  expectOnly("it's one two three four five six oak street", "street_address", "one two three four five six oak street");
  expectOnly("twelve thousand three hundred forty five main street", "street_address");
});

// This is the ratchet: everyday messages, from tests/corpus/normal-messages.txt and its Spanish -es.txt, must not
// warn at all. If a message still warns while its fix waits, it goes into ACCEPTED, named by the start of the
// message and its issue number. These lists may only shrink. Once a message stops warning, its entry has to come
// out, or the test fails until it does. Both lists started empty, since the score was already zero, and every
// wrong warning found here also gets its own regression test.
const ACCEPTED = {
  "normal-messages.txt": [],
  "normal-messages-es.txt": [],
};

function readCorpus(file) {
  const fs = require("node:fs");
  const path = require("node:path");
  return fs
    .readFileSync(path.join(__dirname, "corpus", file), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A corpus that should warn about nothing can go wrong in four ways: a message warns and isn't accepted, an
// accepted entry no longer warns, an accepted entry names no single message, or it has no issue number.
function ratchetProblems(msgs, accepted) {
  const warned = msgs.map((m) => [m, detect(m)]).filter(([, f]) => Object.keys(f).length);
  const problems = warned
    .filter(([m]) => !accepted.some((a) => a.message && m.startsWith(a.message)))
    .map(([m, f]) => `wrong warning ${JSON.stringify(Object.keys(f))} ← ${m.slice(0, 80)}`);
  for (const a of accepted) {
    const named = msgs.filter((m) => a.message && m.startsWith(a.message));
    if (named.length !== 1) problems.push(`ACCEPTED must name one message (${named.length} start "${a.message}")`);
    else if (!warned.some(([m]) => m === named[0]))
      problems.push(`no longer warns, take it out of ACCEPTED: "${a.message}" (${a.issue})`);
    if (!/^#\d+$/.test(a.issue || "")) problems.push(`ACCEPTED needs an issue number: "${a.message}"`);
  }
  return problems;
}

for (const [file, min] of [
  ["normal-messages.txt", 150],
  ["normal-messages-es.txt", 60],
])
  test(`the ratchet: no wrong warnings in the everyday messages (${file})`, () => {
    const msgs = readCorpus(file);
    assert.ok(msgs.length >= min, `corpus has only ${msgs.length} messages`);
    assert.deepEqual(ratchetProblems(msgs, ACCEPTED[file]), []);
  });

test("the ratchet fails on a planted wrong warning, and on an ACCEPTED entry that passes", () => {
  const msgs = ["Explain quantum entanglement like I'm 10 years old.", `my key is ${FAKE.aws}, is it still live?`];
  assert.match(ratchetProblems(msgs, []).join("\n"), /^wrong warning \["aws_access_key"\] ← my key is/);
  assert.deepEqual(ratchetProblems(msgs, [{ message: "my key is", issue: "#1" }]), []);
  assert.match(
    ratchetProblems(msgs, [
      { message: "my key is", issue: "#1" },
      { message: "Explain quantum", issue: "#2" },
    ]).join("\n"),
    /^no longer warns, take it out of ACCEPTED: "Explain quantum" \(#2\)$/,
  );
  assert.match(ratchetProblems(msgs, [{ message: "my key is" }]).join("\n"), /needs an issue number/);
  // An entry can't accept everything at once
  assert.match(ratchetProblems(msgs, [{ message: "", issue: "#3" }]).join("\n"), /must name one message/);
});

test("not phones: digits inside IDs and hashes, lists of small numbers", () => {
  expectNone("The API returned request id 7c9e6679-7425-40de-944b-e07fc1f90ae7 with a 500 error.");
  expectNone("Explain the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55.");
  expectNone("build a1b2c3d4-9375-5501-23ef finished");
  // still phones: whole runs in any grouping, and two numbers in one list
  expectOnly("call 5 5 5 5 5 5 0 1 2 3 please", "phone_number", "5 5 5 5 5 5 0 1 2 3");
  assert.deepEqual(detect("reach us at 555-555-0123, 555-555-0199")["phone_number"], ["555-555-0123", "555-555-0199"]);
  expectOnly("my number is 555-555-O636", "phone_number", "555-555-O636");
});

// Page text is attacker-controlled, so no pattern may backtrack badly on hostile input, the ReDoS bug class. Each
// pattern here gets 10,000 characters of repeated fragments it cares about. Before it was fixed, the email pattern
// took about 3 seconds on 20,000 characters of "a-a-a-…".
test("no pattern is slow on hostile text (ReDoS fuzz)", () => {
  const N = 10000;
  const units = [
    "a",
    "1",
    " ",
    "-",
    ".",
    "@",
    "_",
    "a1",
    "a ",
    "1 ",
    "1-",
    "a.",
    "a-",
    "Aa",
    "one ",
    "one-",
    "at ",
    "dot ",
    "a at ",
    "a dot ",
    "password: ",
    "key=",
    "sk-",
    "eyJa.",
    "postgres://",
    "a:b@",
    "10.",
    "192.168.",
    "host.",
    "born ",
    "1/",
    "account number ",
    "main street ",
    "1 main ",
    "PO Box ",
    "+4",
    "(",
    "O",
    "l",
    "a\n",
    "xxxxx=",
    "1. ",
    "1. 2\n",
    "nine, ",
    "password is ",
    "code is ",
    "login a / ",
    "vivo en calle ",
    "backup codes are ",
    "VIN ",
    "car 1HGCM8",
    "1HGCM82633A004352 ",
    "(1HGCM82633A004352). ",
    "((((",
    "A004352 2003 ",
    "order 1HGCM82633A004352 ",
    "SID ",
    "SID 2048123 ",
    "S-1-",
    "student ID ",
    "matrícula A1 ",
    "plate number A1 ",
    "placas son ",
  ];
  // Absolute budgets depend on the machine: one regression passed locally at 149 ms and failed in CI at 201 ms. So
  // this also compares growth, since 4 times the text should take about 4 times the time, not 16 times. It takes
  // the best of 3 runs, because a garbage-collection pause inside a single run once looked like 11 times growth in CI.
  const time = (p, text) => bestOfBoth(() => (p.find ? p.find(text) : text.match(p.regex)));
  const make = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n) + "!";
  const slow = [];
  for (const u of units) {
    for (const p of globalThis.Clotr.PATTERNS) {
      const check = () => {
        const mid = time(p, make(u, N));
        if (mid.over(150))
          return `${p.id} on ${JSON.stringify(u)}: ${mid.wall.toFixed(0)} ms at ${N} (${mid.allowed.toFixed(0)} allowed on this computer now)`;
        if (mid.wall < 4) return; // too fast to measure growth reliably
        const [smallText, bigText] = [make(u, N / 2), make(u, N * 2)];
        const [small, big] = bestOfPair(
          () => (p.find ? p.find(smallText) : smallText.match(p.regex)),
          () => (p.find ? p.find(bigText) : bigText.match(p.regex)),
          4,
        );
        if (grewMoreThan(small, big, 10, 0.5))
          return `${p.id} on ${JSON.stringify(u)}: ${small.wall.toFixed(1)} → ${big.wall.toFixed(1)} ms for 4× the text (grows faster than linear)`;
      };
      if (!check()) continue;
      try {
        retrySlow(check, { tries: 2 }); // the first try already missed
      } catch (e) {
        slow.push(e.message);
      }
    }
  }
  assert.deepEqual(slow, []);
});

test("your ID's fingerprint ignores case, like the format match does", () => {
  const { fingerprint } = globalThis.Clotr;
  assert.equal(fingerprint("s4lt", "my_id", "AB-123456"), fingerprint("s4lt", "my_id", "ab-123456"));
  assert.notEqual(fingerprint("s4lt", "my_id", "AB-123456"), fingerprint("s4lt", "my_id", "AB-123457"));
});

// This covers what people actually paste into AI chats. The fake tokens are generated here, in the real formats,
// so no secret-looking string ever gets committed.
test("leak corpus: common service tokens, auth headers and password labels are caught", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gen = (n, set = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") =>
    Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join("");
  const hex = (n) => gen(n, "0123456789abcdef");
  const digits = (n) => gen(n, "0123456789");
  const cases = [
    ["service_token", `my Hugging Face token is hf_${gen(34)}`],
    ["service_token", `//registry.npmjs.org/:_authToken=npm_${gen(36)}`],
    ["service_token", `twine upload -u __token__ -p pypi-AgEIcHlwaS5vcmc${gen(60)}`],
    ["service_token", `GITLAB=glpat-${gen(20)}`],
    ["service_token", `sendgrid: SG.${gen(22)}.${gen(43)}`],
    ["service_token", `twilio api key SK${hex(32)}`],
    ["service_token", `mailgun key-${hex(32)}`],
    ["service_token", `shopify admin shpat_${hex(32)}`],
    ["service_token", `do token dop_v1_${hex(64)}`],
    ["service_token", `bot: ${digits(10)}:AA${gen(33)}`],
    ["service_token", `discord bot token M${gen(25)}.${gen(6)}.${gen(38)}`],
    ["service_token", `AccountName=acct;AccountKey=${gen(86)}==;EndpointSuffix=core.windows.net`],
    ["service_token", `post to https://hooks.slack.com/services/T${digits(9)}/B${digits(11)}/${gen(24)}`],
    ["service_token", `https://discord.com/api/webhooks/${digits(19)}/${gen(68)}`],
    ["password", `curl -H "Authorization: Bearer ${gen(32)}" https://api.example.com/v1`],
    ["password", `curl -H "x-api-key: ${gen(40)}" https://api.example.com`],
    ["password", "login: jdoe / pass: Tr0ub4dor&3"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
});

test("not a phone: a dotted IP address", () => {
  assert.equal(detect("my home IP is 73.162.44.201, how do I port forward")["phone_number"], undefined);
  assert.equal(detect("ping 24.199.103.87 from the router")["phone_number"], undefined);
});

test("not a secret: references to environment/config variables in code", () => {
  expectNone("In my Express app I read the key with api-key: process.env.OPENAI_KEY");
  expectNone('password: os.environ["DB_PASSWORD"]');
  expectNone("token = import.meta.env.VITE_TOKEN");
  expectNone("secret: config.stripeSecret");
});

// These are all public test vectors: BIP-39 sample mnemonics, the Ethereum docs sample key, the standard example
// IBAN, the canonical test SIN, and HMRC's example NI prefix.
test("leak corpus: crypto wallet secrets, international IDs, medical record numbers, your IP", () => {
  const cases = [
    ["crypto_secret", "my seed phrase is legal winner thank year wave sausage worth useful legal winner thank yellow"],
    [
      "crypto_secret",
      "recovery words:\n1. abandon 2. abandon 3. abandon 4. abandon 5. abandon 6. abandon\n7. abandon 8. abandon 9. abandon 10. abandon 11. abandon 12. about",
    ],
    ["crypto_secret", "private key 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"],
    ["bank_account", "wire it to IBAN DE89 3704 0044 0532 0130 00 please"],
    ["bank_account", "my iban is GB82WEST12345698765432"],
    ["national_id", "my national insurance number is AB 12 34 56 C"],
    ["national_id", "my SIN is 046 454 286"],
    ["medical_record", "patient MRN 00123456, admitted Tuesday"],
    ["public_ip", "my home IP is 73.162.44.201 how do I port forward"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
});

test("not personal: ordinary prose, hashes, invalid IBANs, 9-digit numbers without a label", () => {
  expectNone("I want to abandon the project because the team can't agree on the design or the budget for next year.");
  expectNone("commit 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318 broke the build");
  expectNone("the invoice id DE89 3704 0044 0532 0130 01 is wrong"); // bad checksum
  expectNone("order 046454286 shipped");
  expectNone("the server at 8.8.8.8 answers DNS");
});

// Text copied from web pages, documents and chat apps can carry invisible or look-alike characters. They must
// never hide a leak, and Hide it must remove what's really there.
test("invisible and look-alike characters don't hide a leak (and matches are the original text)", () => {
  const K = "AKIA4HPQ7XZ2R6TWLJ3N";
  const cases = [
    ["aws_access_key", "key AKIA4HPQ​7XZ2R6TWLJ3N"], // zero-width space
    ["aws_access_key", "key AKIA‍4HPQ7XZ2R6TWLJ3N"], // zero-width joiner
    ["aws_access_key", "key AKIA4HP­Q7XZ2R6TWLJ3N"], // soft hyphen
    ["aws_access_key", "key ⁦" + K + "⁩"], // bidi isolates
    ["phone_number", "call 555 555 0123"], // no-break space (web pages, Word)
    ["phone_number", "call 555 555 0123"], // narrow no-break space
    ["phone_number", "call 555—555—0123"], // em dash
    ["phone_number", "call ５５５-５５５-０１２３"], // full-width
    ["phone_number", "call ٥٥٥-٥٥٥-٠١٢٣"], // Arabic-Indic digits
    ["us_ssn", "ssn １２３-４５-６７８９"],
    ["us_ssn", "ssn 123 - 45 - 6789"], // thin spaces
    ["email", "mail jane.doe＠gmail.com"], // full-width @
    ["email", "mail jane.do​e@gmail.com"],
    ["credit_card", "card 4111​1111​1111​1111"],
  ];
  const missed = [];
  for (const [id, text] of cases) {
    const found = detect(text)[id];
    // Each match has to be a real piece of the original text, so Hide it can actually remove it.
    if (!found || !found.every((m) => text.includes(m)))
      missed.push(`${id} ← ${JSON.stringify(text)} → ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, []);
  // The zero-width space is part of what gets hidden, not left behind.
  assert.deepEqual(detect("key AKIA4HPQ​7XZ2R6TWLJ3N")["aws_access_key"], ["AKIA4HPQ​7XZ2R6TWLJ3N"]);
});

// A phone keyboard curls every quote and apostrophe as you type, like "driver’s" or “…”. A curly one has to read
// like a straight one, so a label still counts and a quote around a detail isn't mistaken for part of it.
test("a phone keyboard's curly quotes and apostrophes read like straight ones", () => {
  const cases = [
    ["drivers_license", "driver’s license L3776868 (ohio)", "L3776868"],
    ["drivers_license", "Driver‘s license E3587362 (Ohio)", "E3587362"],
    ["drivers_license", "driverʼs license C7261816", "C7261816"], // the modifier apostrophe some keyboards type
    [
      "connection_string",
      "DATABASE_URL=“postgres://admin:Sup3rS3cret99@db.internal:5432/app”",
      "postgres://admin:Sup3rS3cret99@db.internal:5432/app",
    ],
  ];
  const wrong = [];
  for (const [id, text, value] of cases) {
    const found = detect(text)[id];
    if (!found || found.length !== 1 || found[0] !== value) wrong.push(`${id} ← ${text} → ${JSON.stringify(found)}`);
  }
  assert.deepEqual(wrong, []);
  expectNone("It’s “fine”, isn’t it? I’ll text you at five.");
});

// Two spaces typed on a phone become ". ", so a label can end up holding a dot it never had. The messages below
// are made up, typed on a phone or shaped like they were; every value in them is made up too. Each case is
// [kind, message, the detail it must find as that kind].
function phoneDotMisses(cases) {
  const missed = [];
  for (const [id, text, value] of cases) {
    const found = detect(text)[id];
    if (!found || found.length !== 1 || found[0] !== value) missed.push(`${id} ← ${text} → ${JSON.stringify(found)}`);
  }
  return missed;
}

test("a phone keyboard's dot between a label's words", () => {
  const cases = [
    ["drivers_license", "driver’s. license L8426037 (ohio)", "L8426037"],
    ["date_of_birth", "My date. Of birth is 07/28/1972.", "07/28/1972"],
    ["date_of_birth", "my date of. birth is 03/09/1977.", "03/09/1977"],
    ["student_id", "write to my professor that my student. id is 5239946 and i missed the quiz.", "5239946"],
    [
      "otp_secret",
      "La clave de configuración. Del autenticador es SLCFIHH4ACOZF23I, ¿dónde la pongo?",
      "SLCFIHH4ACOZF23I",
    ],
    [
      "otp_secret",
      "La clave de. Configuración del autenticador es UR5JXGXXQ5NIEQCF — ¿dónde la pongo?",
      "UR5JXGXXQ5NIEQCF",
    ],
  ];
  assert.deepEqual(phoneDotMisses(cases), []);
});

test("a phone keyboard's dot right after a label", () => {
  const cases = [
    ["passport", "Passport number. G54295338 expires next year", "G54295338"],
    ["drivers_license", "driver's license. W7095785 (ohio)", "W7095785"],
    ["date_of_birth", "my date of birth. is 10/07/1980.", "10/07/1980"],
    ["license_plate", "my licence plate. is HB40 ZVX — can you help me appeal the parking fine?", "HB40 ZVX"],
    ["gamer_tag", "mi usuario de roblox. es crimson.82 y alguien me pide la contraseña", "crimson.82"],
    ["us_ssn", "my ssn. 219099999", "219099999"],
  ];
  assert.deepEqual(phoneDotMisses(cases), []);
});

test("a phone keyboard's dot after the word that joins a label to its detail", () => {
  const cases = [
    ["student_id", "Mi matrícula es. A00644770 y no me deja entrar al portal", "A00644770"],
    ["student_id", "Mi número de estudiante es. 90380033, ¿me ayudas con la beca?", "90380033"],
    ["license_plate", "La matrícula es. 0846 DGL — ¿cuándo me toca pasar la ITV?", "0846 DGL"],
    ["license_plate", "The other driver's license plate was. 8ZFR723 — what do I tell the insurance?", "8ZFR723"],
    ["password", "The AnyDesk code is. 991 250 691 — the man from the bank is waiting", "991 250 691"],
    // No sentence ends on "is": the capital after this dot is the keyboard's, and the word is the detail.
    ["password", "my password is. Sunshine", "Sunshine"],
    ["gamer_tag", "My Roblox username is. Crimsonfox", "Crimsonfox"],
  ];
  assert.deepEqual(phoneDotMisses(cases), []);
});

test("a phone keyboard's dot before a label", () => {
  const cases = [
    ["public_ip", "my. ip is 24.2.87.168 — is my router hacked?", "24.2.87.168"],
    ["password", "Me pidieron. El código 768670 por teléfono, ¿se lo doy?", "768670"],
  ];
  assert.deepEqual(phoneDotMisses(cases), []);
});

test("a label abbreviated with dots: S.S.N., D.O.B., lic., D.L., fecha de nac.", () => {
  const cases = [
    ["us_ssn", "S.S.N. 219099999", "219099999"],
    ["us_ssn", "my S.S.N. is 219099999", "219099999"],
    ["date_of_birth", "D.O.B. 03/09/1977", "03/09/1977"],
    ["drivers_license", "driver's lic. D4826193", "D4826193"],
    ["drivers_license", "Driving lic. no. D4826193", "D4826193"],
    ["drivers_license", "D.L. D4826193", "D4826193"],
    ["date_of_birth", "fecha de nac. 03/09/1977", "03/09/1977"],
    ["drivers_license", "lic. de conducir 48261937", "48261937"],
  ];
  assert.deepEqual(phoneDotMisses(cases), []);
});

// The same dot still ends sentences. When a label sits at the end of one and a number or capitalised word starts
// the next, that next word isn't a detail: it isn't a password, and nothing gets read across the dot.
test("a sentence that ends on a label stays quiet", () => {
  for (const text of [
    "I lost my ID. 2 days later it turned up in the laundry.",
    "I renewed my passport. 6 weeks later it finally came.",
    "I changed my password. Thanks for the tip!",
    "Forgot my password. Again.",
    "Update your password. Then log in.",
    "Please enter the passcode. Thanks.",
    "Cambié mi contraseña. Gracias por el consejo.",
    "Perdí mi cédula. 2 días después apareció.",
    "We counted to twelve. Oak Street was next on the parade route.",
    "I changed my password. Thanks for the tip about the password. Manager!",
    // After "es" the capital is the keyboard's: "demasiado" is an everyday word, not a handle.
    "Mi nick en Minecraft es. Demasiado largo para el servidor.",
    // A question inside a sentence can end on "is": there the dot is a sentence's end.
    "I forgot what my password is. Thanks for helping me reset it.",
    "i don't know what my roblox username is. lol",
    "that's what my password was. honestly",
    "Olvidé mi contraseña. ¿Algún consejo?",
    "olvidé mi contraseña. carmesí es mi color favorito.",
  ])
    expectNone(text);
});

test("reading a phone keyboard's dots as spaces stays fast on hostile text", () => {
  let runs = 0; // each run gets its own text, so no kept answer hides the work
  assertLinear(
    (text) => globalThis.Clotr.detect(text + " ".repeat(++runs % 7)),
    (u, n) => u.repeat(n),
    ["a. b ", "a. B ", "is. A ", "what is. A ", "my ssn. 1 ", "contraseña. ¿a ", "7 Oak Dr. "],
    5000,
  );
});

// A word right after "contraseña" or "password" only counts as one when it looks like one: a digit, a symbol, or
// mixed case. An accented letter is a letter, not a symbol, and "¿" or "¡" opens a Spanish question, not a password.
test("an accented word or a Spanish question after a password word isn't a password", () => {
  for (const text of [
    "olvidé mi contraseña también",
    "cambié la contraseña después de eso",
    "olvidé mi contraseña ¿algún consejo?",
    "Cambié la contraseña ¡por fin!",
  ])
    expectNone(text);
  expectOnly("mi contraseña Café2024", "password", "Café2024");
  expectOnly("contraseña: Ñandú!", "password", "Ñandú!");
  expectOnly("mi contraseña es corazón", "password", "corazón");
  expectOnly("my password niñoBonito", "password", "niñoBonito");
});

// A detail must never span a sentence end: a full stop before a capital, a "?", a "!", or a line break. The shapes
// below used to warn, built by joining tens of thousands of everyday sentence ends to everyday sentence starts and
// checking them all the same way. Every value here is made up.
test("a full stop between a number and a street word isn't an address", () => {
  for (const text of [
    "I'll be there in 5 minutes. Drive safe!",
    "We bought 2 tickets. Elm Street Theater was packed.",
    "Order 555 never arrived. Main Street was closed for the parade.",
    "We drove 300 miles. Highway traffic was awful.",
    "We met at twelve thirty. Elm Street was busy.",
    "I'll be there in 5 min. Drive safe.",
    "See you at 5 p.m. Drive safe!",
    "We land at 6 a.m. Main Street will still be closed.",
    // No capitals: the dot after "minutes" ends the sentence just the same.
    "i'll be there in 5 minutes. drive safe",
    "we bought 2 tickets. elm street theater was packed",
  ])
    expectNone(text);
  // A house number in words stops at a line break: "twenty" is the line above's.
  assert.deepEqual(detect("It's twenty to twenty\nTwelve Oak Street was where I grew up").street_address, [
    "Twelve Oak Street",
  ]);
  // The street after the sentence end is still found, on its own.
  expectOnly("I waited 5 minutes. 42 Oak Street was the place.", "street_address", "42 Oak Street");
});

test("a full stop inside an address, after an abbreviation or an initial, is still part of it", () => {
  expectOnly("I live at 123 Main St. Apt 4", "street_address", "123 Main St. Apt 4");
  expectOnly("Send it to 4500 St. Louis Ave, please", "street_address", "4500 St. Louis Ave");
  expectOnly("4500 N. Oak Ridge Road Apt 4B", "street_address", "4500 N. Oak Ridge Road Apt 4B");
  expectOnly("We're at 100 Mt. Vernon Ave now", "street_address", "100 Mt. Vernon Ave");
  expectOnly("Ship it to 418 Maple Dr. Springfield, IL 62704", "street_address", "418 Maple Dr. Springfield, IL 62704");
  expectOnly("Vivo en Calle Mayor No. 5", "street_address", "Calle Mayor No. 5");
  // An envelope's lines: the city, state and ZIP on the next line belong to the address above.
  expectOnly("123 Main St\nSpringfield, IL 62704", "street_address", "123 Main St\nSpringfield, IL 62704");
  // "Dr." before a name is a doctor, and a time's "a.m." ends no detail early.
  expectNone("I have an appointment at 3 with Dr. Okafor.");
  expectOnly("Meet me at 10 a.m. Call 555-555-0123 if you're late", "phone_number", "555-555-0123");
});

test("numbers on both sides of a sentence end aren't one phone number", () => {
  for (const text of [
    "It happened back in 2019. Nine one one is for emergencies.",
    "It's 2024. Five five five is a fake prefix.",
    "It's twenty twenty four. Eight five five is toll free.",
    "Text 555. Oh one two three is the end of it.",
    "See you at nine thirty. Oh one two three is the end of it.",
    // Two spaces a phone keyboard made a dot, inside "twenty to twenty five".
    "Bake at three fifty for twenty to twenty. Five minutes",
  ])
    expectNone(text);
  // The number after the sentence end is found on its own (the year before it hid it).
  expectOnly(
    "It's 2024. Five five five five five five zero one two three is my cell",
    "phone_number",
    "Five five five five five five zero one two three",
  );
});

test("a phone number split on purpose still counts", () => {
  expectOnly("Call 555. 555. 0123", "phone_number", "555. 555. 0123");
  expectOnly("call five five five. five five five. zero one two three", "phone_number");
  // A phone keyboard's capital after each dot: three, three and four digits make the whole number.
  expectOnly(
    "My number is five five five. Five five five. Zero one two three",
    "phone_number",
    "five five five. Five five five. Zero one two three",
  );
  expectOnly("Five five five five five five. Zero one two three", "phone_number");
  expectOnly("My SSN is two one nine. Zero nine. Nine nine nine nine", "us_ssn");
});

test("a password word ending a line doesn't make the next line's first word a password", () => {
  for (const text of [
    "I forgot my password\nDrive safe!",
    "Update the password\nThanks!",
    "I forgot my password\nSarah said hi.",
    "Olvidé mi contraseña\nGracias.",
  ])
    expectNone(text);
  expectOnly("I forgot my password\nSummer2024 didn't work either", "password", "Summer2024");
  expectOnly("Password:\nHunter2!", "password", "Hunter2!");
});

test("a phone keyboard's dot after “the” doesn't start a sentence for a gamer tag's label", () => {
  expectNone("The. Xbox name is Microsoft's");
  expectNone("The. Xbox name is Crimsonfox");
  expectOnly("my. Xbox name is Crimsonfox", "gamer_tag", "Crimsonfox");
});

test("reading sentence ends stays fast on hostile text", () => {
  let runs = 0; // each run gets its own text, so no kept answer hides the work
  assertLinear(
    (text) => globalThis.Clotr.detect(text + " ".repeat(++runs % 7)),
    (u, n) => u.repeat(n),
    ["5 ab. Dr ", "9 a. b. Oak St ", "2019. Nine ", "one. Two. ", "pw\nDrive ", "The. Xbox name is "],
    1500,
  );
});

test("fingerprints ignore invisible characters and look-alike digits", () => {
  const { fingerprint } = globalThis.Clotr;
  assert.equal(fingerprint("s", "phone_number", "555 555 0123"), fingerprint("s", "phone_number", "555 555 0123"));
  assert.equal(fingerprint("s", "email", "jane.do​e@gmail.com"), fingerprint("s", "email", "jane.doe@gmail.com"));
});

// PDF parsing runs on attacker-controlled files, so finding the streams must stay linear. A regex version of this
// once took 24 seconds on 900 KB of unclosed "<<" dictionaries.
test("PDF streams: found in a real-shaped file, and hostile files stay fast", () => {
  const { findPdfStreams } = globalThis.Clotr;
  const NL = String.fromCharCode(10);
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Length 12 /Filter /FlateDecode /DecodeParms << /Predictor 1 >> >>",
    "stream",
    "xxxxxxxxxxxx",
    "endstream endobj",
    "2 0 obj <</Length 5>>stream",
    "abcde",
    "endstream",
  ].join(NL);
  const found = findPdfStreams(pdf);
  assert.equal(found.length, 2);
  assert.match(found[0].dict, /\/FlateDecode/);
  assert.equal(pdf.slice(found[1].start, found[1].start + 5), "abcde");
  assertLinear(
    findPdfStreams,
    (u, n) => "%PDF " + u.repeat(n) + ">> endobj stream" + NL,
    ["<< /A <x ", "<< /A (x) ", "stream ", ">> stream" + NL],
    25000,
  );
});

test("PDF page text: literal strings, TJ arrays and ToUnicode-mapped fonts; hostile streams stay fast", () => {
  const { pdfPageText } = globalThis.Clotr;
  const cmap =
    "begincmap 2 beginbfchar <0001> <0039> <0002> <0033> endbfchar 1 beginbfrange <0010> <0019> <0030> endbfrange endcmap";
  const page = "BT /F1 12 Tf (call me at ) Tj [(555)-120(-555-)] TJ <001000110012> Tj ET BT <00010002> Tj ET";
  const text = pdfPageText([cmap, page]);
  assert.match(text, /call me at 555-555-012/);
  assert.match(text, /55/);
  assertLinear(
    (x) => pdfPageText([x]),
    (u, n) => "BT " + u.repeat(n) + " Tj",
    ["(", "<0", "beginbfchar ", "[(", "(a\\"],
  );
});

// Office documents are attacker-controlled too, so stripping their tags must stay linear. The first tag stripper,
// /<[^>]*>/g, took 54 seconds on 600 KB of "<a <a <a…".
test("Office XML to text: paragraphs and entities read; hostile XML stays fast", () => {
  const { xmlToText } = globalThis.Clotr;
  assert.equal(
    xmlToText(
      "<w:p><w:r><w:t>call 555-555-0123</w:t></w:r></w:p><w:p><w:t>Tom &amp; Ann &#64; home</w:t></w:p>",
    ).trim(),
    "call 555-555-0123\nTom & Ann @ home",
  );
  assertLinear(xmlToText, (u, n) => u.repeat(n), ["<a ", "&aaaa", "</w:", "<w:p"]);
});

// This stress-tests thousands of random messages built from the pieces detectors look for: digits, number words,
// separators, @ and dots, key prefixes, and invisible and full-width characters. It's seeded, so a failure
// reproduces. None of them may throw, and none may be slow.
test("fuzz: 3,000 random messages never break detection and each stays fast", () => {
  let seed = 20260925;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const Z = String.fromCharCode(0x200b),
    NBSP = String.fromCharCode(0xa0),
    FW5 = String.fromCharCode(0xff15);
  const parts = [
    "0",
    "1",
    "5",
    "9",
    "12",
    "555",
    "614",
    "0147",
    "-",
    ".",
    " ",
    "  ",
    "(",
    ")",
    "+1",
    "@",
    "gmail",
    ".com",
    "five",
    "nine",
    "oh",
    "zero",
    "hundred",
    "my",
    "phone",
    "number",
    "is",
    "password",
    ":",
    "=",
    "AKIA",
    "sk-",
    "ghp_",
    "xoxb-",
    "Bearer ",
    "\n",
    "\t",
    Z,
    NBSP,
    FW5,
    "Street",
    "Ave",
    "apt",
    "#",
    "ssn",
    "dob",
    "IBAN",
    "DE89",
    "/",
    "\\",
    "é",
    "ü",
    "🙂",
  ];
  let slowest = 0;
  let slowestText = "";
  for (let i = 0; i < 3000; i++) {
    const len = 1 + Math.floor(rand() * (i % 50 === 0 ? 2000 : 60));
    let text = "";
    for (let j = 0; j < len; j++) text += pick(parts);
    const t = performance.now();
    assert.doesNotThrow(() => globalThis.Clotr.detect(text), `case ${i}: ${JSON.stringify(text.slice(0, 80))}`);
    const ms = performance.now() - t;
    if (ms > slowest) [slowest, slowestText] = [ms, text];
  }
  // Each message gets one run, so a single slow moment could make any of them look slow. The slowest one gets
  // timed again before the test fails on it.
  if (slowest >= 250)
    retrySlow(() => {
      const t = bestOfBoth(() => globalThis.Clotr.detect(slowestText));
      if (t.over(250))
        return `slowest message took ${t.wall.toFixed(1)} ms (${t.cpu.toFixed(0)} of processor, ${t.allowed.toFixed(0)} allowed on this computer now): ${JSON.stringify(slowestText.slice(0, 80))}`;
    });
});

test("Spanish: phone numbers spelled out in Spanish, mixed with digits", () => {
  expectOnly("mi número es cinco cinco cinco cinco cinco cinco cero uno cuatro siete", "phone_number");
  expectOnly("llámame al 6 uno dos tres cuatro cinco seis siete ocho", "phone_number");
  expectNothing("tengo dos o tres preguntas");
  expectNothing("todos los días a las siete");
  expectOnly("mi móvil es 612 345 678", "phone_number", "612 345 678");
  expectOnly("mi fijo es 93 412 34 56", "phone_number", "93 412 34 56"); // a landline
  expectOnly("my SSN is 219-09-9999", "us_ssn"); // 9 digits without a phone word stay an SSN
});

test("Spanish: numbers said in pairs and hundreds, as people read out phone numbers", () => {
  expectOnly("mi móvil es seis cero cero, doce, treinta y cuatro, cincuenta y seis", "phone_number");
  expectOnly(
    "llámame al quinientos cincuenta y cinco, quinientos cincuenta y cinco, doce, treinta y cuatro",
    "phone_number",
  );
  expectOnly(
    "mi celular es cincuenta y cinco, doce, treinta y cuatro, cincuenta y seis, setenta y ocho",
    "phone_number",
  );
  expectOnly("mi teléfono: seis veintidós, dieciséis, cuarenta, noventa y nueve", "phone_number");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("seis cero cero, doce, treinta y cuatro, cincuenta y seis"), fp("600 12 34 56"));
  // Ages, prices and counts stay quiet
  expectNothing("tengo treinta y cinco años y ahorré dos mil euros");
  expectNothing("cuesta quinientos euros y éramos veinte personas");
  expectNothing("nací en mil novecientos ochenta y dos");
});

// "once" means eleven in Spanish but is an everyday English word, so it only counts as a digit among other Spanish
// number words in a phone number. Found in the 10,000-message test corpus.
test("Spanish: phone numbers read in pairs that include 'once'", () => {
  for (const phone of [
    "seis tres cinco, sesenta y cuatro, once, veintiuno",
    "seis nueve tres, once, once, treinta y cinco",
    "seis cuatro nueve, once, cincuenta y cuatro, setenta",
    "seis tres cinco, sesenta y cuatro, veintiuno, once",
  ])
    expectOnly(`mi número es ${phone}, llámame luego`, "phone_number", phone);
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("seis tres cinco, sesenta y cuatro, once, veintiuno"), fp("635 64 11 21"));
  // English "once" stays a word, even right after a number
  expectNothing("once upon a time there were three bears");
  expectNothing("I'll call you once I'm home");
  expectNothing("call me once you're home");
  expectNothing("I once had 3 cats");
  expectOnly(
    "call me at five five five five five five five six three six once you're home",
    "phone_number",
    "five five five five five five five six three six",
  );
  // Spanish "once" in dates, times and counts stays quiet
  expectNothing("la reunión es el once de marzo a las once");
  expectNothing("tengo once gatos, doce perros y trece gallinas");
  expectNothing("diez, once, doce, trece, catorce");
  expectNothing("seis siete ocho nueve diez once doce");
  expectNothing("nos casamos en dos mil once");
});

// Counting aloud can read like a phone number, "one … ten", or an SSN, "one … nine", but number words that go up
// or down by one are just a count. A phone word or an SSN label right before them still says what they are, the
// same as it does for the equivalent digits.
test("counting aloud, up or down, in English or Spanish, isn't a phone number or an SSN", () => {
  const EN =
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(
      " ",
    );
  const ES = "cero uno dos tres cuatro cinco seis siete ocho nueve diez".split(" ");
  expectNothing("one two three four five six seven eight nine ten");
  expectNothing("one, two, three, four, five, six, seven, eight, nine, ten");
  expectNothing("uno dos tres cuatro cinco seis siete ocho nueve diez");
  expectNothing("uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, diez");
  expectNothing("one two three four five six seven eight nine");
  expectNothing("uno dos tres cuatro cinco seis siete ocho nueve");
  expectNothing("ten, nine, eight, seven, six, five, four, three, two, one");
  expectNothing("eight seven six five four three two one zero");
  expectNothing("ocho siete seis cinco cuatro tres dos uno cero");
  expectNothing("seven six five four three two one, liftoff!");
  expectNothing("my kid can count to ten now: one two three four five six seven eight nine ten!");
  expectNothing("count with me: twenty one, twenty two, twenty three, twenty four, twenty five");
  // Every count of three words or more, from anywhere, up or down, with spaces or commas
  for (const words of [EN, ES]) {
    for (let from = 0; from < words.length; from++) {
      for (let to = from + 2; to < words.length; to++) {
        const up = words.slice(from, to + 1);
        for (const run of [up, [...up].reverse()])
          for (const sep of [" ", ", "]) expectNothing(`let's count: ${run.join(sep)}`);
      }
    }
  }
  // Real spelled-out numbers still warn, even with a stretch that counts
  expectOnly(
    "call me at nine one two three four five six seven eight nine",
    "phone_number",
    "nine one two three four five six seven eight nine",
  );
  expectOnly(
    "my number is two one two three four five six seven eight nine",
    "phone_number",
    "two one two three four five six seven eight nine",
  );
  expectOnly(
    "mi móvil es seis uno dos tres cuatro cinco seis siete ocho",
    "phone_number",
    "seis uno dos tres cuatro cinco seis siete ocho",
  );
  expectOnly("my ssn is two one nine zero nine nine nine nine nine", "us_ssn");
  expectOnly("my ssn is one two three four five six seven nine eight", "us_ssn");
  // Spelled-out digits that could read as either a phone number or an SSN still warn, same as the digits would.
  expectOnly("my ssn is one two three four five six seven eight nine", "us_ssn");
  expectOnly("ssn: 123-45-6789", "us_ssn");
  expectOnly("call me at one two three four five six seven eight nine ten", "phone_number");
  // Digits are read as before
  expectOnly("2345678910", "phone_number");
  expectOnly("call me at 234-567-8910", "phone_number");
  expectNothing("1234567890");
});

test("security-question answers are secrets", () => {
  expectOnly("my mother's maiden name is Smith", "password", "Smith");
  expectOnly("the answer to my security question is Rover", "password", "Rover");
  expectOnly("my first pet's name was Biscuit", "password", "Biscuit");
  expectOnly("el apellido de soltera de mi madre es García", "password", "García");
  expectNothing("what is a maiden name?");
  expectNothing("The security question was easy, what should my answer be?");
  expectOnly("my security answer is Rover", "password", "Rover");
  expectNothing("my first pet's name was a secret to everyone");
});

test("Spanish: passwords said the way people write them", () => {
  expectOnly("mi contraseña es Gato2024!", "password", "Gato2024"); // the "!" ends the sentence, as in English
  expectOnly("la contraseña del wifi es sol-y-luna", "password", "sol-y-luna");
  expectOnly("clave: Xk9#mP2q", "password", "Xk9#mP2q");
  expectNothing("olvidé la contraseña de mi correo");
  expectNothing("mi contraseña es incorrecta");
  expectOnly("el pin de mi tarjeta es 4821", "password", "4821");
  expectOnly("la clave de mi correo es Luna2020", "password", "Luna2020");
});

test("Spanish and Mexican ID numbers (checksum-validated)", () => {
  expectOnly("mi DNI es 12345678Z", "national_id", "12345678Z");
  expectOnly("NIE X1234567L por favor", "national_id", "X1234567L");
  expectOnly("CURP: GODE561231HDFRRN00", "national_id", "GODE561231HDFRRN00");
  expectNothing("GODE561231HDFRRN04"); // wrong check digit
  expectNothing("12345678A"); // wrong DNI letter
  expectNothing("referencia 87654321B del pedido"); // wrong letter too
  // Mexico's RFC and Spain's social security number: only after their label
  expectOnly("mi RFC es PEPJ800101AB3", "national_id", "PEPJ800101AB3");
  expectOnly("RFC: GOD8012315Q7", "national_id", "GOD8012315Q7"); // a company's (3 letters)
  expectOnly("mi número de la seguridad social es 28 1234567840", "national_id", "28 1234567840");
  expectOnly("NSS: 281234567840", "national_id", "281234567840");
  expectNothing("see RFC 7231 and RFC 9110 section 15");
  expectNothing("mi RFC es PEPJ801301AB3"); // no month 13
  expectNothing("la seguridad social es importante para 2026");
  assert.equal(globalThis.Clotr.PATTERNS.find((p) => p.id === "national_id").name, "National ID Number");
});

test("Spanish street addresses", () => {
  expectOnly("vivo en Calle Mayor 5, Madrid", "street_address");
  expectOnly("la oficina está en Avenida Paseo de la Reforma 222", "street_address");
  expectOnly("envíalo a C/ Alcalá, 45", "street_address");
  expectOnly("vivo en la calle Mayor número 5, tercero B", "street_address");
  assert.equal(globalThis.Clotr.addressCore("Calle Mayor número 5"), globalThis.Clotr.addressCore("calle mayor 5"));
  expectNothing("la calle está mojada");
  expectNothing("vivo cerca de una avenida con mucho tráfico");
  // Typed all in lowercase, right after an address phrase
  expectOnly("vivo en calle mayor 5, madrid", "street_address");
  expectOnly("mi dirección es avenida de la constitución 12", "street_address");
  expectOnly("mándalo a c/ alcalá 45", "street_address");
  expectNothing("la calle 5 está cortada");
  expectNothing("paseo por la avenida 3 veces al día");
  expectNothing("en la plaza mayor 3 niños jugaban");
  expectNothing("vivo en la calle de al lado hace 5 años");
});

// These are ways people in Spanish-speaking countries write who they are, which Clotr used to miss. Each one
// counts only right after its own label, as the kind it already has. Every number here is made up.
test("leak corpus: Mexico's NSS, Argentina's and Peru's DNI, Colombia's cédula, Chile's RUT", () => {
  // Mexico's social security number: 11 digits after "NSS", "IMSS" or "seguro/seguridad social"
  expectOnly("mi NSS es 12345678901", "national_id", "12345678901");
  expectOnly("Número de Seguridad Social (NSS): 4219 7612 345", "national_id", "4219 7612 345");
  expectOnly("mi número del IMSS es 32-17-85-4521-6", "national_id", "32-17-85-4521-6");
  expectOnly("Mi número de seguro social es 03128512347, ¿qué clínica me toca?", "national_id", "03128512347");
  // Argentina's DNI with dots; Argentina's and Peru's DNI as 7 or 8 digits
  expectOnly("DNI 30.571.264", "national_id", "30.571.264");
  expectOnly("mi D.N.I. es 7.123.456", "national_id", "7.123.456");
  expectOnly("Mi DNI es 45871236 y vivo en Arequipa", "national_id", "45871236");
  expectOnly("DNI N° 30571264", "national_id", "30571264");
  // Colombia's cédula (and other countries' cédula de identidad), after "cédula", "C.C." or "CC"
  expectOnly("C.C. No. 79.456.123 de Bogotá", "national_id", "79.456.123");
  expectOnly("mi cédula es 1.023.456.789", "national_id", "1.023.456.789");
  expectOnly("CC 1023456789", "national_id", "1023456789");
  expectOnly("cédula de ciudadanía: 52987654", "national_id", "52987654");
  expectOnly("Cédula de identidad V-12.345.678", "national_id", "V-12.345.678");
  // Chile's RUT, with a right check digit
  expectOnly("RUT 12.345.678-5", "national_id", "12.345.678-5");
  expectOnly("mi R.U.T. es 7.654.321-6", "national_id", "7.654.321-6");
  expectOnly("rut: 11.111.112-K", "national_id", "11.111.112-K");
  expectOnly("mi número de RUT es 16400233-0", "national_id", "16400233-0");
  expectOnly("RUN 12.345.678-5", "national_id", "12.345.678-5");
  // The same labels in an English sentence
  expectOnly("my IMSS number is 12345678901", "national_id", "12345678901");
  expectOnly("my DNI is 30.571.264", "national_id", "30.571.264");
  // Not these
  expectNothing("RUT 12.345.678-4"); // wrong check digit
  expectNothing("el DNI tiene 8 cifras");
  expectNothing("DNI 123456789 no existe"); // 9 digits
  expectNothing("la cédula del contrato vence en 2027");
  expectNothing("el NSS tiene 11 dígitos y la CURP 18 caracteres");
  assert.equal(detect("IMSS: 01 800 623 2323").national_id, undefined); // the IMSS help line isn't an NSS
  expectNothing("cc 1023456789"); // "CC" and "RUN" count only in capitals
  expectNothing("I run 12.345.678-5 tests a day");
  expectNothing("CC BY 4.0, version 2.0.1");
  expectNothing("Mi DNI es 12345678A"); // Spain's, with a wrong letter: Spain's own rule decides
  expectOnly("Mi DNI es 12345678Z", "national_id", "12345678Z");
});

test("leak corpus: pasaporte, licencia de manejo, historia clínica, expediente, Medicaid es, número de afiliada", () => {
  expectOnly("mi pasaporte es G12345678", "passport", "G12345678");
  expectOnly("Número de pasaporte: AAB123456", "passport", "AAB123456");
  expectOnly("licencia de manejo: A1234567", "drivers_license", "A1234567");
  expectOnly("mi licencia de conducir es 12345678", "drivers_license", "12345678");
  expectOnly("número de licencia de conducir 912345678", "drivers_license", "912345678"); // not a phone
  expectOnly("mi brevete es Q45871236", "drivers_license", "Q45871236");
  expectOnly("historia clínica 778812", "medical_record", "778812");
  expectOnly("Número de historia clínica: HC-2023-11873", "medical_record", "HC-2023-11873");
  expectOnly("mi expediente es 778812", "medical_record", "778812");
  expectOnly("No. de expediente: 45-77812", "medical_record", "45-77812");
  expectOnly("expediente clínico 4471-2290", "medical_record", "4471-2290");
  // Medicaid is a health plan: its number counts as an insurance member ID, as in English
  expectOnly("Su Medicaid ID es 4471093826", "insurance_id", "4471093826");
  expectOnly("Su número de Medicaid es 9920418832", "insurance_id", "9920418832");
  expectOnly("número de afiliada: 15234987/02", "insurance_id", "15234987/02");
  expectOnly("Mi número de afiliado es 61234567801", "insurance_id", "61234567801");
  expectOnly("número de afiliado 912345678", "insurance_id", "912345678"); // not a phone
  expectOnly("número de afiliado: 61 234567 8 01", "insurance_id", "61 234567 8 01");
  // In English, a license number in brackets after its label
  expectOnly("my driver's license (D1234567) expired", "drivers_license", "D1234567");
  expectOnly("Driver's license number (S12345678)", "drivers_license", "S12345678");
  // Not these
  expectNothing("mi pasaporte vence en 2027");
  expectNothing("la licencia de conducir cuesta 1500 pesos");
  expectNothing("la historia clínica del hospital está en papel");
  expectNothing("la historia clínica 2019 se perdió");
  expectNothing("el número de expediente 1234/2023 del juzgado");
  expectNothing("el expediente académico tiene 12 materias");
  expectNothing("¿Medicaid es gratis? Explícame los waivers 1115");
  expectNothing("Medicaid 1115 waivers, explained");
  expectNothing("somos 3000 afiliados y el afiliado 4521 ganó la rifa");
  expectNothing("el número de afiliado 2025-2026 se renueva en enero");
  expectNothing("my driver's license (expired in 2024) needs renewing");
});

test("leak corpus: Colombia's numbered streets", () => {
  expectOnly("vivo en la Carrera 15 # 93-47, Bogotá", "street_address", "Carrera 15 # 93-47");
  expectOnly("Calle 72 # 10-34", "street_address", "Calle 72 # 10-34");
  expectOnly("mándalo a la Cra. 7 No. 45-10, apto 302", "street_address", "Cra. 7 No. 45-10");
  expectOnly("Av. Calle 26 # 69-76", "street_address", "Av. Calle 26 # 69-76");
  expectOnly("la oficina queda en la calle 45A bis sur #23-12", "street_address", "calle 45A bis sur #23-12");
  const core = globalThis.Clotr.addressCore;
  assert.equal(core("Cra. 15 No. 93 - 47"), "carrera 15 # 93-47");
  assert.equal(core("Carrera 15 #93-47"), core("carrera 15 # 93-47"));
  assert.equal(core("Av. Calle 26 # 69-76"), core("Avenida Calle 26 #69-76"));
  assert.notEqual(core("Av. Calle 26 # 69-76"), core("Av. Calle 26 # 12-34"));
  // Not addresses
  expectNothing("la calle 72 es bonita");
  expectNothing("corrí la carrera 15 de la maratón");
  expectNothing("Calle 13 fue #1 en 2009");
  expectNothing("en la carrera 3 # de dorsal 10-12 llegaron juntos");
});

test("Hide it leaves no part of a Spanish ID or a Colombian street behind", () => {
  const { detect: find, redact } = globalThis.Clotr;
  const left = [];
  for (const line of [
    "mi NSS es 12 34 56 7890 1 gracias",
    "DNI 30.571.264 y nada más",
    "C.C. No. 79.456.123 de Bogotá",
    "RUT 12.345.678-5 por favor",
    "número de afiliada: 15234987/02 ok",
    "vivo en la Carrera 15 # 93-47, Bogotá",
    "Av. Calle 26 # 69-76 piso 3",
  ]) {
    const covered = redact(line, find(line));
    if (/\d{2}/.test(covered.replace(/\[REDACTED [^\]]*\]/g, ""))) left.push(`${line} → ${covered}`);
    else if (find(covered).length) left.push(`${line} → still found in "${covered}"`);
  }
  assert.deepEqual(left, []);
});

test("Spanish ID labels, Colombian streets, NDC codes and doctors' titles stay fast on hostile text", () => {
  const kinds = ["national_id", "passport", "drivers_license", "medical_record", "insurance_id", "street_address"];
  const finds = globalThis.Clotr.PATTERNS.filter((p) => kinds.includes(p.id));
  const all = (text) => finds.forEach((p) => p.find(text));
  assertLinear(
    all,
    (u, n) => u.repeat(n),
    [
      "NSS ",
      "IMSS: 1 ",
      "DNI 1.",
      "cédula 1.",
      "C.C. No. ",
      "RUT 1.",
      "pasaporte ",
      "historia clínica ",
      "mi expediente ",
      "Medicaid ID es ",
      "afiliado 1/",
      "(NSS) ",
      "Carrera 1 # ",
      "calle 1 bis # 1",
      "Av. Calle 1 # 1-",
      "1 with Dr. ",
      "NDC 1-",
      "número de ",
    ],
    2500,
  );
  assertLinear(all, (u, n) => "mi NSS es " + u.repeat(n), [" ", "1 ", "1-", "a"], 2500);
  const phones = globalThis.Clotr.PATTERNS.find((p) => p.id === "phone_number").find;
  assertLinear(phones, (u, n) => u.repeat(n), ["NDC 1-", "NSS 12 ", "número de afiliado 9 "], 2500);
});

// This builds a stand-in for chrome.i18n from the Spanish translation file.
test("translations: Spanish with values filled in; English when a message is missing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const es = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "extension", "_locales", "es", "messages.json"), "utf8"),
  );
  const getMessage = (key, subs = []) => {
    const m = es[key];
    if (!m) return "";
    return m.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const n = Number(/^\$(\d)$/.exec(m.placeholders[name].content)[1]);
      return subs[n - 1] ?? "";
    });
  };
  const { msg } = globalThis.Clotr;
  globalThis.chrome = { i18n: { getMessage } };
  try {
    assert.equal(
      msg("choiceLogKinds", "Leave it in, and stop warning me about: $1", "Número de teléfono"),
      "Dejarlo, y dejar de avisarme de: Número de teléfono",
    );
    assert.equal(
      msg("tipHow", "How should Clotr treat $1 from now on?", "a Phone Number", "Número de teléfono"),
      "¿Cómo quieres que Clotr trate este tipo de dato (Número de teléfono) a partir de ahora?",
    );
    assert.equal(msg("noSuchKey", "Only in English, $1", "here"), "Only in English, here");
  } finally {
    delete globalThis.chrome;
  }
  assert.equal(msg("coverIt", "Hide it"), "Hide it", "without chrome.i18n (tests, a lost context): English");
  assert.equal(
    msg("noKey", "Renews at $5 a seat"),
    "Renews at $5 a seat",
    "no substitution arguments: a literal $5 stays, never swapped for an empty string",
  );
});

test("Spanish addresses in the vault: accepted, and the same address matches however it's written", () => {
  const { addressCore, fingerprint } = globalThis.Clotr;
  assert.equal(addressCore("Calle Alcalá 45"), "calle alcalá 45");
  assert.equal(addressCore("c/ Alcalá, 45"), "calle alcalá 45");
  assert.equal(addressCore("Avda. de la Constitución 12"), "avenida de la constitución 12");
  const fp = (m) => fingerprint("salt", "street_address", m);
  assert.equal(fp("C/ Alcalá, 45"), fp("calle alcalá 45"));
  assert.equal(fp("Calle Alcalá 45"), fp("calle alcala 45")); // with or without accents
  // What detection finds in a chat matches what you saved in the vault.
  const found = detect("envíalo a C/ Alcalá, 45 por favor").street_address[0];
  assert.equal(fp(found), fp("Calle Alcalá 45"));
});

// This checks questions people ask about passwords, public toll-free numbers, and codes a scam caller asks for.
test("not a secret or a phone: a password manager question, toll-free numbers", () => {
  expectNone("What is a good password manager?");
  expectNone("Is a password generator safe!");
  expectNone("Call 911 if it happens again, or poison control at 1-800-222-1222.");
  expectNone("their support line is (888) 555-0199 or 1 877 555 0100");
});

test("leak corpus: texted verification codes, a bare pin number, a security question with its topic", () => {
  const cases = [
    ["password", "the verification code they texted me is 482913, what do I do with it"],
    ["password", "They called from Microsoft and asked for the code 739201, should I give it?"],
    ["password", "my one-time code: 552 019"],
    ["password", "they sent me a code 8841 by text"],
    ["password", "the OTP is 283746"],
    ["password", "Here's my 2FA: 482 913"],
    ["password", "pin number 5832"],
    ["password", "my pin 5832 for the debit card"],
    ["password", "the answer to my security question (first pet) is Rusty"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("the error code is 404 and the verification code expired");
  expectNone("I sent the code 2024 version to my boss");
  expectNone("I never got the verification code in 2024");
  expectNone("the booking confirmation code is 7712, see you Friday");
  expectNone("she sent me the code snippet 2048 lines long");
  expectNone("pin 13 on the arduino, and set pin number 12 to high");
  expectNone("my pin is loose on the hinge");
});

// These were missed while writing the website's examples: the code named before who sent it, and "asking for"
// instead of "asked for", which is how someone talks while a scam caller is still on the line.
test("leak corpus: 'the code they texted me: 482913', 'asking for the code'", () => {
  const cases = [
    ["password", "The bank is on the phone asking for the code they texted me: 482913. Should I read it to them?"],
    ["password", "the code that they sent me is 552019"],
    ["password", "he keeps asking for the code 739201"],
    ["password", "what's the code she emailed you, 8841?"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("the code they sent me in 2024 still works");
  expectNone("the code they sent me yesterday had a bug on line 4821");
  expectNone("I'm asking for the code review by Friday");
});

test("leak corpus: misspelled passwords, what the password is for, SS#, keypad codes with dashes", () => {
  const cases = [
    ["password", "my pasword is Rover2011"],
    ["password", "my passwrod is Rover2011"],
    ["password", "my pw is rover2011"],
    ["password", "my password for netflix is Rover2011"],
    ["password", "password to my email is rover2011"],
    ["password", "the password for my bank account is Tulip!55"],
    ["password", "the passward is Bluebird44"],
    ["password", "our house alarm code is 1-9-7-5"],
    ["us_ssn", "My SS# is 219099999"],
    ["us_ssn", "my soc sec number 219099999"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("the password for everything is the same, is that bad?");
  expectNone("my password for work is too long to remember");
  expectNone("the combination is 1-2-3-4 on the demo lock");
  expectNone("the passwords for these accounts were changed");
  expectNone("the password to the router is printed on the back");
  assert.ok(detect("the password for my kid's ipad is 1234 but he changed it").password);
});

test("Spanish: verification codes, a password for something, free-phone numbers", () => {
  const cases = [
    ["password", "el código de verificación es 482913"],
    ["password", "me mandaron un código por SMS: 552019"],
    ["password", "el código que me llegó es 739201, lo doy?"],
    ["password", "me pidieron el código 739201"],
    ["password", "mi contraseña para el banco es Tulip55"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("llama al 900 123 456, es gratuito");
  expectNone("el código de verificación caduca en 2024");
  expectNone("el código de confirmación de la reserva es 7712");
  expectNone("me mandaron el código fuente 2048 líneas");
});

// These were missed while writing the practice drills: a sign-in code named after its value, like "texted me
// 482913 as a verification code", a Spanish verb in the singular like "Mi banco me mandó un código por SMS:
// 482913", and a bank account after its Spanish label like "número de cuenta 1234567890". Each is tested with its
// everyday family, in English and Spanish, and the codes keep their reason: a sign-in code sent to you.
test("sign-in codes: the code before its label, who sent it and how, the text it came in", () => {
  for (const text of [
    "texted me 482913 as a verification code",
    "they texted me 482913 as my login code",
    "the bank sent me 482913 as a one-time code",
    "I got 482913 as my verification code",
    "482913 is my code",
    "482913 is my verification code, should I give it to him?",
    "482913 is the verification code they sent",
    "482913 is the code they texted me",
    "482913 - that's the code they sent me",
    "G-482913 is your Google verification code. Don't share it with anyone.",
    "the code they sent to my phone is 482913",
    "the code they sent by text is 482913",
    "the code I got is 482913",
    "the code I received by text: 482913",
    "the code I was sent is 482913",
    "the code from the text is 482913",
    "the code in the email is 482913",
    "the code that came to my phone is 482913",
    "the passcode they sent me is 482913",
    "my code is 482913",
    "I got a text with the code 482913",
    "I received a code 482913, what is it for?",
    "Your WhatsApp code: 482-913",
    "my Google code is 482913",
  ])
    assert.deepEqual(asksOf(text), ["login_code"], text);
  expectOnly("texted me 482913 as a verification code", "password", "482913");
  expectOnly("482913 is my code", "password", "482913");
});

test("Spanish sign-in codes: 'me mandó', 'me ha llegado', a one-time key, the code before its label", () => {
  for (const text of [
    "Mi banco me mandó un código por SMS: 482913",
    "me envió un código de verificación: 482913",
    "me ha llegado un código 482913, ¿qué hago?",
    "me han mandado un código por mensaje: 482913",
    "me llegó un SMS con el código 482913",
    "el código que me mandó el banco es 482913",
    "el código que me han mandado es 482913",
    "el código que me acaba de llegar es 482913",
    "el código que me llegó al móvil es 482913",
    "clave de acceso de un solo uso 482913",
    "mi clave de acceso de un solo uso es 482913",
    "la contraseña de un solo uso es 482913",
    "la clave dinámica es 482913",
    "el código de WhatsApp que me llegó es 482-913",
    "el código de 6 dígitos que me llegó es 482913",
    "el código de seguridad que me llegó por SMS es 482913",
    "el código del SMS es 482913",
    "482913 es mi código",
    "482913 es el código de verificación",
    "482913 es el código que me mandaron",
    "me mandaron 482913 como código de verificación",
    "mi código es 482913",
    "me están pidiendo el código 482913",
  ])
    assert.deepEqual(asksOf(text), ["login_code"], text);
  expectOnly("Mi banco me mandó un código por SMS: 482913", "password", "482913");
  expectOnly("clave de acceso de un solo uso 482913", "password", "482913");
});

test("not sign-in codes: tracking, promo and error codes, zip codes, a medical code, a code with no value", () => {
  for (const text of [
    "the tracking code they sent me is 48291345",
    "the promo code they emailed me is 4821",
    "the error code they gave me is 5001",
    "the discount code they texted me is 202512",
    "they sent me a tracking code 48291345",
    "she asked for the zip code 90210",
    "I got the code 1500 from the tutorial",
    "in my code 1234 is the port number",
    "12345 is my code name for the project",
    "error 4821 - that's the code they gave me for the error",
    "4821 is my code for the gate",
    "My order number is 112-4567890-1234567 and the tracking number is 9400111899223197428490.",
    "The ambulance came as a code 3. What does code 3 mean?",
    "90210 is my zip code",
    "60614 is the zip code they gave me",
    "the verification code expired, how do I get a new one?",
    "The code they texted me expired before I could type it in.",
    "my code is 3000 lines long, can you review it?",
    "the code I got from the tutorial is 1500 lines",
    "the code in the email is broken, it shows the wrong date",
    "the error code in the email is 5001",
    "212 is the area code for Manhattan",
    "el código de seguimiento que me mandaron es 48291345",
    "el código de descuento que me enviaron es 4821",
    "28013 es mi código postal",
    "el código postal que me dieron es 28013",
    "el código de verificación caducó, ¿cómo pido otro?",
    "mi código tiene 3000 líneas, ¿lo revisas?",
    "el código del mensaje de error es 5001",
    "me mandaron 3 códigos de descuento",
  ])
    expectNone(text);
});

test("bank accounts in Spanish: número de cuenta, cuenta bancaria, CLABE and CBU by their check digits, IBAN", () => {
  for (const [text, value] of [
    ["número de cuenta 1234567890", "1234567890"],
    ["mi número de cuenta es 1234567890", "1234567890"],
    ["el número de cuenta es el 1234567890", "1234567890"],
    ["Nº de cuenta: 1234567890", "1234567890"],
    ["mi cuenta bancaria es 1234567890", "1234567890"],
    ["cuenta bancaria: 1234 5678 90", "1234 5678 90"],
    ["mi cuenta corriente 0123-4567-89", "0123-4567-89"],
    ["cuenta de ahorros 12345678901", "12345678901"],
    ["número de cuenta bancaria 1234567890", "1234567890"],
    ["1234567890 es mi número de cuenta", "1234567890"],
    ["1234567890 is my account number", "1234567890"],
    // Mexico's CLABE (18 digits, the last a check digit) and Argentina's CBU and CVU (22, with two)
    ["mi CLABE es 999180001234567899", "999180001234567899"],
    ["mi clabe interbancaria: 999180001234567899", "999180001234567899"],
    ["Mi CLABE interbancaria para el depósito es 999180001234567899", "999180001234567899"],
    ["mi CBU es 9990001800001234567891", "9990001800001234567891"],
    ["CVU: 0000003110001234567898", "0000003110001234567898"],
    // An IBAN after its name, in any case
    ["iban: es26 0000 1234 5612 3456 7890", "es26 0000 1234 5612 3456 7890"],
    ["mi IBAN es ES26 0000 1234 5612 3456 7890", "ES26 0000 1234 5612 3456 7890"],
  ])
    expectOnly(text, "bank_account", value);
  // A wrong check digit isn't a CLABE or a CBU.
  for (const text of ["mi CLABE es 999180001234567890", "mi CBU es 9990001800001234567892"])
    assert.equal(detect(text).bank_account, undefined, text);
});

test("sign-in codes and Spanish bank accounts stay fast on hostile text", () => {
  let runs = 0; // each run gets its own text, so no kept answer hides the work
  assertLinear(
    (text) => globalThis.Clotr.detect(text + " ".repeat(++runs % 7)),
    (u, n) => u.repeat(n),
    [
      "482913 is my ",
      "texted me 4821 as ",
      "the code they sent ",
      "4821 - ",
      "código que me mandó ",
      "me mandó el código de ",
      "número de cuenta 1 ",
      "clabe 1 ",
      "CLABE 999180001234567899 ",
      "1234567890 es mi ",
    ],
    1500,
  );
});

test("not bank accounts: talk about accounts with no number, order and tracking numbers, money in an account", () => {
  for (const text of [
    "¿Dónde encuentro mi número de cuenta en la app del banco?",
    "El número de cuenta tiene 10 dígitos y la CLABE tiene 18, ¿cuál les doy?",
    "¿Qué es una cuenta CLABE y para qué sirve?",
    "El CBU tiene 22 dígitos, ¿dónde lo veo?",
    "¿Cuál es la diferencia entre una cuenta corriente y una cuenta de ahorros?",
    "Abrí una cuenta de ahorros en 2019 con 500 euros.",
    "Mi número de pedido es 112-4567890-1234567 y el número de seguimiento es 9400111899223197428490.",
    "Tengo en mi cuenta de ahorros 150000 pesos, ¿cómo los invierto?",
    "mi cuenta bancaria: 150000 pesos ahorrados, ¿es suficiente?",
    "Where do I find my account number on a check?",
  ])
    expectNone(text);
});

test("leak corpus: a school locker combination, with dashes or spaces", () => {
  assert.ok(detect("i go to lincoln middle school and my locker combo is 12-34-08").password);
  assert.ok(detect("my locker combination is 24 12 36").password);
  expectNone("the combination is 1 2 3 on the demo lock");
  expectNone("my lock screen is 3 by 3 grid");
});

test("not a secret: a year after OTP, words describing a password", () => {
  expectNone("OTP 2024 conference in Houston");
  expectNone("the password for 2FA is separate");
  expectNone("the password for the account is expiring in 5 days");
  assert.ok(detect("the password for guest wifi is guest").password); // that one really is the password
});

// Generalizing keeps a birth date's month and year, and an address's town, instead of removing them outright.
// Anything that can't be made general is still hidden as before, and the result never holds the exact detail.
test("generalize: a birth date becomes its month and year, an address its town", () => {
  const { detect: find, generalize, generalForms } = globalThis.Clotr;
  const gen = (text) => generalize(text, find(text), "en-US");
  assert.equal(gen("I was born on 03/14/1948"), "I was born on March 1948");
  assert.equal(gen("born March 14, 1948 in Ohio"), "born March 1948 in Ohio");
  assert.equal(gen("DOB: 1948-03-14"), "DOB: March 1948");
  assert.equal(gen("my birthday is 14 March 1948"), "my birthday is March 1948");
  // 04/05 could be April 5 or May 4, so I keep only the year here and never guess at a month.
  assert.equal(gen("I was born on 04/05/1948"), "I was born on 1948");
  assert.equal(gen("my address is 123 Oak Street, Springfield, IL 62704"), "my address is Springfield");
  assert.equal(gen("send it to 42 Elm Ave, Portland OR 97201 please"), "send it to Portland please");
  // There's no town to keep here, so this address still gets hidden like before.
  assert.equal(gen("I live at 123 Oak Street"), "I live at [REDACTED STREET ADDRESS]");
  // When both show up together, the date gets generalized and the phone number still gets hidden.
  const mixed = gen("born 03/14/1948, call me at 555-555-0123");
  assert.equal(mixed, "born March 1948, call me at [REDACTED PHONE NUMBER]");
  // The month name follows the language, so a Spanish birth date gets a Spanish month.
  const es = (text) => generalize(text, find(text), "es-ES");
  assert.equal(es("nací el 14/03/1948"), "nací el marzo de 1948");
  assert.equal(es("mi fecha de nacimiento es 14 de marzo de 1948"), "mi fecha de nacimiento es marzo de 1948");
  // This is what the button shows, and it comes back empty when there's nothing to generalize.
  assert.deepEqual(
    generalForms(find("born 03/14/1948, call me at 555-555-0123"), "en-US").map((g) => g.general),
    ["March 1948"],
  );
  assert.deepEqual(generalForms(find("call me at 555-555-0123"), "en-US"), []);
  // Running detection again on the generalized message should find nothing left to catch.
  for (const t of ["I was born on 03/14/1948", "my address is 123 Oak Street, Springfield, IL 62704"]) {
    assert.deepEqual(find(gen(t)), [], `still found in "${gen(t)}"`);
  }
});

// These Spanish birth-date forms weren't being caught before.
test("Spanish birth dates: nacido/nacida, nacimiento:, and year-month-day", () => {
  assert.deepEqual(detect("fecha de nacimiento: 1948-03-14").date_of_birth, ["1948-03-14"]);
  assert.deepEqual(detect("nacido el 14/03/1948 en Madrid").date_of_birth, ["14/03/1948"]);
  assert.deepEqual(detect("nacida el 3 de julio de 1962").date_of_birth, ["3 de julio de 1962"]);
  assert.deepEqual(detect("Nacimiento: 14/03/1948").date_of_birth, ["14/03/1948"]);
  // A birthplace on its own, and a date that isn't a birth date, should both stay quiet.
  expectNone("lugar de nacimiento: Madrid");
  expectNone("la reunión es el 14/03/2027");
});

// A huge paste of digits has to stay quick to read. The old code re-checked the whole run for a list marker like
// "1." or "2)" every time a new digit was added, so 40,000 digits took about a second and froze the chat page.
//
// I measure with texts big enough to rise clearly above a 5 ms floor. 10,000 digits took 5 ms and 40,000 took 48 ms,
// and below that floor two very different speeds can look the same, which would let a real regression slip through.
// I read the two sizes in turns and take the best of five, so one slow moment can't hit just one of them. The rule
// is the one used elsewhere: four times the text should take at most about eight times as long, where the old code
// took about sixteen times.
test("reading a long run of digits grows in step with its length (no freeze on a huge paste)", () => {
  let n = 0;
  // Each call uses fresh text, since detect() caches its last result, and timing covers both wall-clock and
  // processor time.
  const read = (digits) => () => globalThis.Clotr.detect("1".repeat(digits) + "x" + n++);
  read(2000)(); // warm up
  retrySlow(() => {
    const [small, big] = bestOfPair(read(20000), read(80000), 4, 5);
    if (grewMoreThan(small, big, 8))
      return `20,000 digits: ${small.wall.toFixed(0)} ms, 80,000: ${big.wall.toFixed(0)} ms (four times the text should take about four times as long)`;
  });
});
