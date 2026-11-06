// Covers Hide it and Keep just the town (extension/detector.js's redact() and generalize()): what they swap
// out, what they leave alone, and how long they take. Every value here is a made-up test value.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");

const { detect, redact, generalize } = globalThis.Clotr;

// A token shape built from obviously synthetic parts, never a real one.
const fakeToken = () => `gh${"p_"}Zq7Xw3Rk9Lm2Np5Vt8Yb4Hc6Jd1Fg0SaEuWi`;
const above = (results) => results.filter((r) => r.severity !== "low").map((r) => r.id);

test("Hide it: a token, email or phone riding inside a cleaned link is hidden too, not kept by the link", () => {
  const cases = [
    `see https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=a1b2c3d4e5f6g7h8&utm_source=x&token=${fakeToken()}`,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=AbCdEfGhIjKlMnOp&email=jane.doe@example.org now",
    "https://www.reddit.com/r/test/comments/abc?share_id=FAKEfake123&phone=555-555-5636",
    "https://app.example.com/invite?utm_source=newsletter&utm_medium=email&email=jane.doe@example.org",
    `https://app.example.com/x?fbclid=IwAR0fakeFAKEfake&key=${fakeToken()}`,
  ];
  for (const text of cases) {
    const found = detect(text);
    assert.ok(
      found.some((r) => r.id === "share_link"),
      `${text}: the link itself should still be found`,
    );
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, /ghp_|jane\.doe@|555-555-5636/, `${text} → ${out}`);
      assert.deepEqual(
        detect(out).filter((r) => r.id !== "share_link" && r.severity !== "low"),
        [],
        `${text} → ${out}`,
      );
      // The link's own tracking parameters still come out, so it's still a cleaned link.
      assert.doesNotMatch(out, /[?&](?:si|utm_source|share_id|fbclid)=/, `${text} → ${out}`);
    }
  }
  // The cleaned link keeps its other parameters, with the value inside swapped for its label.
  const text = cases[0];
  assert.equal(
    redact(text, detect(text)),
    "see https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?token=[REDACTED GITHUB TOKEN]",
  );
  assert.deepEqual(above(detect(redact(text, detect(text)))), []);
});

// Hide it swaps out every copy of a found value, but a short value's digits inside a longer number (a card's
// 3-digit code inside an order number) aren't that value.
test("Hide it: a short value isn't cut out of a longer number it happens to sit inside", () => {
  const card = "My card is 4111 1111 1111 1111, CVV 123. Order #12345 shipped.";
  const hidden = redact(card, detect(card));
  assert.match(hidden, /CVV \[REDACTED [A-Z ]+\]\. Order #12345 shipped\./);
  assert.equal(generalize(card, detect(card), "en-US"), hidden);
  const code = "Your verification code is 482913. Tracking 9482913000.";
  assert.match(redact(code, detect(code)), /code is \[REDACTED [A-Z ]+\]\. Tracking 9482913000\./);
  // Every copy that stands on its own is still hidden.
  const twice = "CVV 123, and again: 123.";
  assert.equal(redact(twice, [{ name: "Card security code", matches: ["123"] }]).match(/123/g), null);
  // A value found only inside a longer word is still hidden there: nothing found is ever left in.
  assert.equal(redact("ref123x", [{ name: "Code", matches: ["123"] }]), "ref[REDACTED CODE]x");
  // A long value (a token) is hidden wherever it appears, glued to other text or not.
  const token = fakeToken();
  assert.doesNotMatch(redact(`a ${token} b x${token}y`, [{ name: "Token", matches: [token] }]), /ghp_/);
});

// Only a longer number makes a short value's copy something else. A letter beside it doesn't: Vietnamese, Chinese
// and Japanese text often runs a word straight into a number ("số078-05-1120", "電話555-555-5636"), where the
// detector finds the value on its own, so a copy beside a letter is hidden like every other.
test("Hide it: a short value next to a letter, in any script, is still hidden", () => {
  const cases = [
    ["SSN 078-05-1120 và số078-05-1120 nữa", "078-05-1120"],
    ["電話 555-555-5636。また電話555-555-5636です", "555-555-5636"],
    ["call 555-555-5636 or call 555-555-5636ext", "555-555-5636"],
    ["My CVV 123 and unit 123B", "123"],
  ];
  for (const [text, value] of cases) {
    const found = detect(text);
    assert.ok(
      found.some((r) => r.matches.includes(value)),
      `${text}: ${value} should be found`,
    );
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.ok(!out.includes(value), `${text} → ${out}`);
      assert.ok(!detect(out).some((r) => r.matches.includes(value)), `${text} → ${out}`);
    }
  }
  // Every copy is hidden even next to a letter, standing alone elsewhere or not.
  assert.equal(
    redact("số078-05-1120 và 078-05-1120", [{ name: "SSN", matches: ["078-05-1120"] }]),
    "số[REDACTED SSN] và [REDACTED SSN]",
  );
});

// A copy written URL-encoded or JSON-escaped is still a copy. The "0" of "%20" or the "2" of "%22" just before a
// short value isn't a digit the value is glued to, so the copy inside a link or a JSON string is hidden like the
// plain one (a later rule once skipped it whenever the value also stood alone elsewhere).
test("Hide it: a short value's URL-encoded or JSON-escaped copy is hidden next to its plain copy", () => {
  const cases = [
    ["My SSN is 219-09-9999.\nhttps://forms.example.com/apply?note=my%20ssn%20is%20219-09-9999", "219-09-9999"],
    ["Call me at 312-867-5309\nhttps://maps.example.com/?q=call%20312-867-5309", "312-867-5309"],
    ['{"phone":"312-867-5309","link":"https://ex.com/?q=%22312-867-5309%22"}', "312-867-5309"],
    ["SSN 219-09-9999. https://forms.example.com/a?note=ssn%20219-09-9999", "219-09-9999"],
    ["SSN 219-09-9999. https://ex.com/a?note=%27219-09-9999%27&b=%28219-09-9999%29", "219-09-9999"],
    // A JSON string can escape any character as \uXXXX: here the first digits and the dashes.
    ['SSN 219-09-9999. {"note":"ssn \\u0032\\u0031\\u0039\\u002d09\\u002D9999"}', "219-09-9999"],
  ];
  for (const [text, value] of cases) {
    const found = detect(text);
    assert.ok(
      found.some((r) => r.matches.includes(value)),
      `${text}: ${value} should be found`,
    );
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.ok(!out.includes(value), `${text} → ${out}`);
      assert.doesNotMatch(out, /219|312/, `${text} → ${out}`);
      assert.ok(!detect(out).some((r) => r.matches.includes(value)), `${text} → ${out}`);
    }
  }
  // The rest stays as written, so the result still reads the same.
  assert.equal(
    redact(cases[0][0], detect(cases[0][0])),
    "My SSN is [REDACTED US SOCIAL SECURITY NUMBER].\n" +
      "https://forms.example.com/apply?note=my%20ssn%20is%20[REDACTED US SOCIAL SECURITY NUMBER]",
  );
  assert.equal(
    redact(cases[2][0], detect(cases[2][0])),
    '{"phone":"[REDACTED PHONE NUMBER]","link":"https://ex.com/?q=%22[REDACTED PHONE NUMBER]%22"}',
  );
  // A digit written as %3X is a digit all the same, so a short value inside a longer number stays there.
  assert.equal(
    redact("CVV 123, order %31234 and order 1234%35", [{ name: "Card security code", matches: ["123"] }]),
    "CVV [REDACTED CARD SECURITY CODE], order %31234 and order 1234%35",
  );
});

// A card number, SSN or phone number written URL-encoded in a form body or an HTTP request line, with no "://" link
// around it, is found and hidden too, and so is that copy of a value found in plain text elsewhere.
test("Hide it: a URL-encoded copy in a form body or HTTP request line is hidden", () => {
  const cases = [
    ["card 4539 1488 0343 6467\nPOST /pay HTTP/1.1\n\ncard=4539%201488%200343%206467&cvv=123", /4539|6467/],
    ["GET /pay?card=4539%201488%200343%206467 HTTP/1.1", /4539|6467/],
    ["call me at (312) 867-5309 / phone=%28312%29%20867-5309", /312|5309/],
    ["SSN 219-09-9999\nssn=219%2D09%2D9999&name=x", /219|9999/],
    ["card 4539 1488 0343 6467\nbody: card=4539+1488+0343+6467&cvv=123", /4539|6467/],
    ['card 4539 1488 0343 6467 {"body":"card=4539%201488%200343%206467"}', /4539|6467/],
    // Written only encoded, with no plain copy anywhere.
    ["ssn=219%2D09%2D9999", /219|9999/],
    ["phone=%28312%29%20867-5309&name=x", /312|5309/],
    ["POST /apply?ssn=219%2D09%2D9999 HTTP/1.1", /219|9999/],
  ];
  for (const [text, leak] of cases) {
    const found = detect(text);
    assert.ok(found.length, `${text}: something should be found`);
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, leak, `${text} → ${out}`);
    }
  }
  assert.equal(
    redact(cases[0][0], detect(cases[0][0])),
    "card [REDACTED CREDIT CARD NUMBER]\nPOST /pay HTTP/1.1\n\ncard=[REDACTED CREDIT CARD NUMBER]&cvv=[REDACTED CARD SECURITY CODE]",
  );
  assert.equal(redact(cases[1][0], detect(cases[1][0])), "GET /pay?card=[REDACTED CREDIT CARD NUMBER] HTTP/1.1");
  // Ordinary text with a percent sign, and a request line or form token with nothing in it, finds nothing.
  for (const quiet of [
    "Progress=50%25 done, CPU at 99%20 minutes in",
    "GET /static/app.css?v=1%2E2%2E3 HTTP/1.1",
    "filter=price%3D100&sort=asc&page=2",
  ]) {
    assert.deepEqual(above(detect(quiet)), [], quiet);
  }
});

// Hiding the encoded copies doesn't reach into ordinary text that only shares digits with a value: the same digits
// in a longer number, grouped another way, or as part of a percentage are left alone.
test("Hide it: text that only shares a value's digits isn't touched", () => {
  const ssn = [{ name: "US social security number", matches: ["219-09-9999"] }];
  for (const text of [
    "SSN 219-09-9999. Ticket 1219-09-99991 and 219099999 and 219 09 9999 stay.",
    "SSN 219-09-9999. Growth was 50%, 219-09-99990 is a part number.",
    "SSN 219-09-9999. Path C:\\new\\2190 and 50%2019 stay.",
  ]) {
    const out = redact(text, ssn);
    assert.equal(out, text.replace("219-09-9999", "[REDACTED US SOCIAL SECURITY NUMBER]"), `${text} → ${out}`);
  }
  const card = [{ name: "Credit card number", matches: ["4539 1488 0343 6467"] }];
  const sum = "card 4539 1488 0343 6467; the sum 4539+1488 is 6027";
  assert.equal(redact(sum, card), "card [REDACTED CREDIT CARD NUMBER]; the sum 4539+1488 is 6027");
});

// The digit just before a copy can be the last character of an escape: "%2520" (a space encoded twice, as a link
// carried in a redirect= parameter writes it), "\x20" or "\040" (JavaScript and Python), "\x22" (a quote). That
// digit isn't one the value is glued to, so the copy is hidden like the plain one, never left whole or half shown.
test("Hide it: a copy right after an escape that ends in a digit is hidden", () => {
  const bs = "\\";
  const cases = [
    ["SSN 219-09-9999. https://ex.com/r?next=https%3A%2F%2Fforms.ex.com%2Fa%3Fnote%3Dssn%2520219-09-9999", /219|9999/],
    [`SSN 219-09-9999. var s = 'note ${bs}x20219-09-9999';`, /219|9999/],
    [`SSN 219-09-9999. py: b'ssn${bs}040219-09-9999'`, /219|9999/],
    [`SSN 219-09-9999. s = "ssn ${bs}u0020219-09-9999 %u0020219-09-9999"`, /219|9999/],
    [`Call 312-867-5309. html = '<a data-q=${bs}x22312-867-5309${bs}x22>'`, /312|5309/],
    ["Call 312-867-5309. https://ex.com/r?next=https%3A%2F%2Fa.ex.com%2Fb%3Fq%3D%2522312-867-5309%2522", /312|5309/],
  ];
  for (const [text, leak] of cases) {
    const found = detect(text);
    assert.ok(found.length, `${text}: something should be found`);
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, leak, `${text} → ${out}`);
    }
  }
  // An escape that stands for a digit is a digit all the same, so a short value inside a longer number stays there.
  const cvv = [{ name: "Card security code", matches: ["123"] }];
  assert.equal(
    redact(`CVV 123, orders %2531123 and ${bs}x31123 and ${bs}061123 and ${bs}u0031123`, cvv),
    `CVV [REDACTED CARD SECURITY CODE], orders %2531123 and ${bs}x31123 and ${bs}061123 and ${bs}u0031123`,
  );
});

// A card number, SSN or phone number URL-encoded in a logged request line or a form body is found wherever the
// request or the form sits on its line: in an access log's quotes, after curl's "> ", indented, after a "?" or
// any other mark, nested in another form ("data=card%3D4539..."), or with its spaces written as "+".
test("A URL-encoded card, SSN or phone number is found anywhere in a request line or form body", () => {
  const cases = [
    [
      '127.0.0.1 - - [02/Nov/2026:10:00:00 +0000] "GET /pay?card=4539%201488%200343%206467 HTTP/1.1" 200 512',
      /4539|6467/,
    ],
    ["> GET /pay?card=4539%201488%200343%206467 HTTP/1.1", /4539|6467/],
    ["  POST /apply?ssn=219%2D09%2D9999 HTTP/1.1", /219|9999/],
    ["wget --post-data=ssn=219%2D09%2D9999 https://ex.com/apply", /219|9999/],
    ["body:ssn=219%2D09%2D9999", /219|9999/],
    ["(ssn=219%2D09%2D9999)", /219|9999/],
    ["q,ssn=219%2D09%2D9999", /219|9999/],
    ["Referer: /apply?ssn=219%2D09%2D9999", /219|9999/],
    ["data=card%3D4539%201488%200343%206467", /4539|6467/],
    ["card=4539+1488+0343+6467&cvv=123", /4539|6467/],
    ["GET /pay?card=4539+1488+0343+6467 HTTP/1.1", /4539|6467/],
  ];
  for (const [text, leak] of cases) {
    const found = detect(text);
    assert.ok(
      found.some((r) => leak.test(r.matches.join(" "))),
      `${text}: should be found, got ${JSON.stringify(found.map((r) => r.matches))}`,
    );
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, leak, `${text} → ${out}`);
    }
  }
  assert.equal(
    redact(cases[9][0], detect(cases[9][0])),
    "card=[REDACTED CREDIT CARD NUMBER]&cvv=[REDACTED CARD SECURITY CODE]",
  );
  // Sums and other text with "+" or "=" in it find nothing.
  for (const quiet of ["the sum 4539+1488 is 6027", "x=1+2+3&y=4", "total=12+30+45", "if (a==b) c=d%2E5"]) {
    assert.deepEqual(above(detect(quiet)), [], quiet);
  }
});

// Raw email source writes a space as "=20" (quoted-printable, and a MIME "=?UTF-8?Q?...?=" subject), Python as
// "\U00000020" and CSS as "\000020". The digit that ends such an escape isn't one a copy is glued to, so the copy is
// hidden. Hide it fails closed: a digit that ends an escape it can't read for sure counts as no digit at all, and only
// an escape known to stand for a digit keeps a short value inside a longer number.
test("Hide it: a copy after a quoted-printable, \\U or CSS escape, or one it can't read, is hidden", () => {
  const bs = "\\";
  const cases = [
    ["Subject: =?UTF-8?Q?My=20SSN=20is=20219-09-9999?=\n\nMy SSN is 219-09-9999.", /219|9999/],
    ["Content-Transfer-Encoding: quoted-printable\n\nMy SSN is 219-09-9999.=20\nAgain:=20219-09-9999", /219|9999/],
    ["Subject: =?UTF-8?Q?Call=20312-867-5309?=\n\nCall 312-867-5309", /312|5309|867/],
    [`SSN 219-09-9999. py: '${bs}U00000020219-09-9999'`, /219|9999/],
    [`SSN 219-09-9999. content: "${bs}000020219-09-9999"`, /219|9999/],
    // Forms it can't read for sure: a 4-digit CSS escape and an HTML reference with no ";".
    [`SSN 219-09-9999. content: "${bs}0020219-09-9999"`, /219|9999/],
    ["SSN 219-09-9999. <p>&#32219-09-9999 &#x20219-09-9999</p>", /219|9999/],
  ];
  for (const [text, leak] of cases) {
    const found = detect(text);
    assert.ok(found.length, `${text}: something should be found`);
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, leak, `${text} → ${out}`);
    }
  }
  assert.equal(
    redact(cases[0][0], detect(cases[0][0])),
    "Subject: =?UTF-8?Q?My=20SSN=20is=20[REDACTED US SOCIAL SECURITY NUMBER]?=\n\n" +
      "My SSN is [REDACTED US SOCIAL SECURITY NUMBER].",
  );
  // An escape that stands for a digit, and a plain number after "=", still keep a short value inside a longer number.
  const cvv = [{ name: "Card security code", matches: ["123"] }];
  const kept = `CVV 123, orders =31123 and id=12123 and ${bs}U00000031123 and ${bs}000031123 and a=2045123`;
  assert.equal(redact(kept, cvv), kept.replace("CVV 123", "CVV [REDACTED CARD SECURITY CODE]"));
});

// A link carried in another link's redirect parameter is encoded twice, so a space in it reads "%2520" and a dash
// "%252D". Inside a link that run reads as the character it stands for, so the card or SSN is found with no plain copy.
test("A card or SSN encoded twice inside a link, or a form after a bracket or encoded whole, is found", () => {
  const cases = [
    ["https://ex.com/login?next=https%3A%2F%2Fshop.ex%2Fpay%3Fcard%3D4539%25201488%25200343%25206467", /4539|6467/],
    ["https://ex.com/login?next=%2Fpay%3Fcard%3D4539%25201488%25200343%25206467", /4539|6467/],
    ["https://ex.com/login?next=%2Fapply%3Fssn%3D219%252D09%252D9999", /219|9999/],
    ["[ssn=219%2D09%2D9999]", /219|9999/],
    ["ssn%3D219%2D09%2D9999", /219|9999/],
  ];
  for (const [text, leak] of cases) {
    const found = detect(text);
    assert.ok(
      found.some((r) => leak.test(r.matches.join(" "))),
      `${text}: should be found, got ${JSON.stringify(found.map((r) => r.matches))}`,
    );
    for (const hide of [redact, (t, r) => generalize(t, r, "en-US")]) {
      const out = hide(text, found);
      assert.doesNotMatch(out, leak, `${text} → ${out}`);
    }
  }
  // A link with ordinary double-encoded text in it finds nothing.
  for (const quiet of [
    "https://ex.com/files/My%2520Report%25202019.pdf",
    "https://ex.com/r?next=%2Fsearch%3Fq%3Dprice%2520100%2525%2520off",
    "https://ex.com/r?u=%252Fdocs%252F2019%252D09%252D12",
  ]) {
    assert.deepEqual(above(detect(quiet)), [], quiet);
  }
});

// Hide it reads the text with its escapes read as characters once a single %XX, JSON escape or "+" is in it, and
// gathered every value's readings in one call with an argument per value, which ran out of stack past about 125,000
// different values and left the paste unhidden.
test("Hide it on a paste of 140,000 different values with an escape in it hides them all", () => {
  const values = Array.from({ length: 140000 }, (_, i) => `u${i.toString(36)}@x.io`);
  const text = `${values.join("\n")}\na%20b`;
  const out = redact(text, [{ name: "Email address", matches: values }]);
  assert.doesNotMatch(out, /@x\.io/);
  assert.ok(out.endsWith("[REDACTED EMAIL ADDRESS]\na%20b"));
});

// Hide it on a big paste with thousands of different values (a CSV of contacts) searched the whole text once per
// value: 36,000 email addresses in 2 MB took 18 seconds. 8 times the rows should take about 8 times as long, where
// values × text would take 64 times as long; the limit of 24 sits well away from both, and a pair has to grow past it
// on three measurements running, since one pause on a busy machine could push a single measurement over it.
test("Hide it on thousands of different values grows with the text, not with values × text", () => {
  const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");
  const rows = (n) => Array.from({ length: n }, (_, i) => `Person ${i},user${i}x@example.org,active`);
  const paste = (n) => {
    const list = rows(n);
    return { text: list.join("\n"), results: [{ name: "Email address", matches: list.map((r) => r.split(",")[1]) }] };
  };
  const small = paste(750);
  const big = paste(6000);
  const out = redact(big.text, big.results);
  assert.doesNotMatch(out, /@example\.org/);
  assert.equal(out.split("\n")[5999], "Person 5999,[REDACTED EMAIL ADDRESS],active");
  const grew = grewEveryTime(
    () =>
      bestOfPair(
        () => redact(small.text, small.results),
        () => redact(big.text, big.results),
        8,
        3,
      ),
    (s, b) => grewMoreThan(s, b, 24),
  );
  assert.ok(!grew, grew && `8× the rows: ${grew[0].wall.toFixed(1)} ms → ${grew[1].wall.toFixed(1)} ms`);
});

// Keep just the town looks past a flat or apartment part to the town, including one named with letters only
// ("Suite B", "Unit Penthouse"), but a town that only starts like one ("Flat Rock") is still the town.
test("Keep just the town: a lettered suite, unit or apartment part isn't taken for the town", () => {
  const town = (text) => generalize(text, detect(text), "en-US");
  assert.equal(
    town("Send it to 10 Main Street, Suite B, Springfield, IL 62704 please"),
    "Send it to Springfield please",
  );
  assert.equal(town("Lives at 12 Oak St, Unit Penthouse, Boston, MA 02108"), "Lives at Boston");
  assert.equal(town("Ship to 22 Acacia Avenue, Apt C, Austin, TX 78701"), "Ship to Austin");
  assert.equal(town("Ship to 22 Acacia Avenue, Apt 4, Austin, TX 78701"), "Ship to Austin");
  assert.equal(town("I live at 12 Oak St, Flat Rock, MI 48134"), "I live at Flat Rock");
  assert.equal(town("I live at Flat 3, 12 Oak Street, London SW1A 1AA"), "I live at London");
});
