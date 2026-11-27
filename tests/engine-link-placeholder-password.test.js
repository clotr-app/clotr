// In a link, a stand-in password and the host after it ("password@db.example.com") aren't an email.
// A real password warns as a connection string, in ssh://, smb:// and every other link.
// So does one that only looks made up, like 12345678. Only clear stand-ins, doc words and blanks stay quiet, and
// a blank is any password that starts with <, {, $, [ or %.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

const emails = (text) =>
  detect(text)
    .filter((result) => result.id === "email")
    .flatMap((result) => result.matches);

const connectionMatches = (text) =>
  detect(text)
    .filter((result) => result.id === "connection_string")
    .flatMap((result) => result.matches);

function linksWith(password) {
  return [`ssh://sam:${password}@files.example.com/x`, `smb://sam:${password}@nas.example.com/share`];
}

test("a link's placeholder password and host aren't read as an email", () => {
  for (const link of [
    "DATABASE_URL=postgres://alex:password@db.example.com/app",
    "mysql://root:changeme@mysql.acme-test.com:3306/shop",
  ]) {
    assert.deepEqual(emails(link), [], link);
  }
});

test("an email on its own is still found", () => {
  assert.deepEqual(emails("write to alex.rivera@example.com"), ["alex.rivera@example.com"]);
});

test("a real password in an ssh:// or smb:// link still warns", () => {
  for (const link of [
    "ssh://deploy:wibblefrogpond@files.wibblecorp.io",
    "mount with smb://sam:CorrectHorseBatteryStaple@nas.wibblecorp.io/share please",
  ]) {
    const connections = detect(link).filter((result) => result.id === "connection_string");
    assert.notDeepEqual(connections, [], link);
  }
});

// ---------- Passwords that only look made up ----------

// People really use these, so in a link they warn and the whole link is covered.
const LOOKS_MADE_UP = [
  "12345678",
  "11111111",
  "aaaaaa",
  "abcdefgh",
  "abcdefghij",
  "test_password",
  "demo_pass",
  "sample-pass",
];

test("a password that only looks made up warns in a link, covered whole", () => {
  for (const password of LOOKS_MADE_UP) {
    for (const link of linksWith(password)) {
      assert.deepEqual(connectionMatches(link), [link], link);
      assert.ok(!redact(link, detect(link)).includes(password), link);
    }
  }
});

// A doc's word only counts as the whole password, so a longer one with the word inside still warns.
test("a password with a doc's word inside warns in a link, covered whole", () => {
  for (const password of ["example123", "mydummy9"]) {
    for (const link of linksWith(password)) {
      assert.deepEqual(connectionMatches(link), [link], link);
      assert.ok(!redact(link, detect(link)).includes(password), link);
    }
  }
});

// ---------- The clearest stand-ins ----------

const STAND_INS = [
  "password",
  "PASSWORD",
  "pass",
  "PASS",
  "passwd",
  "pwd",
  "PWD",
  "secret",
  "SECRET",
  "changeme",
  "xxx",
  "xxxx",
  "XXXXXXXX",
  "***",
  "****",
];

test("the clearest stand-ins stay quiet in a link", () => {
  for (const password of STAND_INS) {
    for (const link of linksWith(password)) {
      assert.deepEqual(detect(link), [], link);
    }
  }
});

// What docs write in a link's password spot, in any case.
const DOC_WORDS = [
  "example",
  "Example",
  "your_password",
  "YOUR_PASSWORD",
  "yourpassword",
  "your-password",
  "your_password_here",
  "placeholder",
  "dummy",
  "redacted",
  "REDACTED",
];

test("a doc's word for a password stays quiet in a link", () => {
  for (const password of DOC_WORDS) {
    for (const link of linksWith(password)) {
      assert.deepEqual(detect(link), [], link);
    }
  }
  assert.deepEqual(detect("postgres://app:your_password@db.example.com/app"), []);
});

// ---------- Blanks: a password that starts with <, {, $, [ or % ----------

// What templates, printf, shells, Make, Compose, CI files, PowerShell, PHP and Perl put in a link's password spot.
// Every list of blank shapes left some out, so the first character decides.
const BLANKS = [
  "<pass>",
  "<<parameters.db_password>>",
  "{pass}",
  "{}",
  "{0}",
  "{{db_password}}",
  "{{{password}}}",
  "[pass]",
  "%PASS%",
  "%s",
  "%(password)s",
  "%{password}",
  "${PASS}",
  "$DB_PASSWORD",
  "$pass",
  "$dbPassword",
  "$2",
  "$(DB_PASSWORD)",
  "$($cfg.Password)",
  "$(<secret.txt)",
  "$$(DB_PASS)",
  "${{secrets.DB_PASSWORD}}",
  "$${DB_PASSWORD}",
  "$$DB_PASS",
  "$[variables.db_password]",
  "$env:PGPASSWORD",
  "${DB_PREFIX}_password",
  "$DB_PASS_${STAGE}",
  "$this->db->password",
  "$config['password']",
  "$settings['db']['password']",
  "$cfg{password}",
  "$cfg->{password}",
  "$cfg->{db}{password}",
  "$ENV{'DB_PASSWORD'}",
];

// A real password written the same way, or a blank cut off mid-word. The link reader can't tell these from a
// blank, so it leaves them too.
const STARTS_LIKE_A_BLANK = [
  "$uperS3cret!",
  "$uper.S3cret",
  "$ecret[99",
  "$(wibble99",
  "{{wibble99}",
  "<pass",
  "[PASSWORD",
];

function blankLinks(password) {
  return [
    `postgres://app:${password}@localhost:5432/app`,
    `mysql://root:${password}@db:3306/shop`,
    `ssh://sam:${password}@files.example.com/x`,
    `nats://app:${password}@db.quillfen.io:4222`,
  ];
}

test("a link password that starts with <, {, $, [ or % isn't read as a login", () => {
  for (const password of [...BLANKS, ...STARTS_LIKE_A_BLANK]) {
    for (const link of blankLinks(password)) {
      assert.deepEqual(connectionMatches(link), [], link);
    }
  }
});

test("a blank in a link to a plain host name stays quiet", () => {
  for (const password of [...BLANKS, ...STARTS_LIKE_A_BLANK]) {
    for (const link of blankLinks(password).slice(0, 2)) {
      assert.deepEqual(detect(link), [], link);
    }
  }
});

// The link no longer claims the "@", so on a dotted host the email reading reads it as it would anywhere else.
test("on a dotted host, what follows a blank's first mark is read as an email", () => {
  for (const [link, email] of [
    ["postgres://app:$Summer.WINTER24@db.quillfen.io", "Summer.WINTER24@db.quillfen.io"],
    ["ssh://sam:$ecret99@files.example.com/x", "ecret99@files.example.com"],
    ["smb://sam:<wibble99@nas.example.com/share", "wibble99@nas.example.com"],
    ["ssh://sam:$DB_PASSWORD@files.example.com/x", "DB_PASSWORD@files.example.com"],
  ]) {
    assert.deepEqual(emails(link), [email], link);
    assert.deepEqual(connectionMatches(link), [], link);
  }
});

// Ruby's #{…} and Swift's \(…) don't start with one of the five, so what's inside is read as a password.
test("a password written as Ruby's #{…} or Swift's \\(…) warns in a link, covered whole", () => {
  for (const password of ["#{maple2093}", "#{maple}2093}", "#{wibble99", "\\(Larch!8812)", "#{pass}", "\\(pass)"]) {
    for (const link of [...linksWith(password), `postgres://app:${password}@localhost:5432/app`]) {
      assert.deepEqual(connectionMatches(link), [link], link);
      assert.ok(!redact(link, detect(link)).includes(password), link);
    }
  }
});

// Everyday config and code lines that fill a database link's password in.
const CODE_FILL_LINES = [
  '          value: "postgresql://app:$(DB_PASSWORD)@postgres:5432/app"',
  "DATABASE_URL ?= postgres://postgres:$(POSTGRES_PASSWORD)@localhost:5432/dev",
  "postgres://app:$(DB_PASSWORD)@db.quillfen.io/app",
  "  DATABASE_URL: postgres://postgres:${{secrets.DB_PASSWORD}}@localhost:5432/test",
  "  DATABASE_URL: postgres://postgres:$${POSTGRES_PASSWORD}@db:5432/app",
  "DATABASE_URL = postgres://app:$$DB_PASS@db/app",
  '$url = "postgres://postgres:$($env:PGPASSWORD)@localhost:5432/app"',
  '$env:DATABASE_URL = "postgres://app:$env:PGPASSWORD@localhost:5432/app"',
  'DATABASE_URL="postgres://app:$(<secret.txt)@db/app"',
  '  connectionString: "postgres://app:$[variables.db_password]@db.quillfen.io/app"',
  '$dsn = "mysql://root:$this->password@localhost/shop";',
  "$dsn = \"mysql://root:$config['password']@localhost/shop\";",
  'my $dsn = "mysql://root:$cfg{password}@localhost/shop";',
  'my $dsn = "mysql://root:$cfg->{password}@localhost/shop";',
  "my $dsn = \"mysql://root:$ENV{'DB_PASSWORD'}@localhost/shop\";",
  "      DATABASE_URL: postgres://app:<<parameters.db_password>>@localhost:5432/app",
  "DATABASE_URL=postgres://app:${DB_PREFIX}_password@db:5432/app",
  'url: "postgres://{{{user}}}:{{{password}}}@{{{host}}}/app"',
  'url = "postgres://%{user}:%{password}@%{host}/app" % cfg',
];

test("everyday lines that fill a link's password in stay quiet", () => {
  for (const line of CODE_FILL_LINES) {
    assert.deepEqual(detect(line), [], line);
  }
});

// Docs and code that build a database link from its parts.
const TEMPLATE_LINES = [
  "postgres://user:pass@localhost:5432/db",
  'url := fmt.Sprintf("postgres://%s:%s@%s:%d/%s", user, pass, host, port, db)',
  'let url = format!("postgres://{}:{}@{}/{}", user, pw, host, db);',
  '$dsn = "mysql://$user:$pass@$host/$db";',
  'url = "postgresql://%(user)s:%(password)s@%(host)s/%(db)s" % cfg',
  'url = "redis://:{}@{}:{}".format(pw, host, port)',
  'url = "postgres://{user}:{password}@{host}/{db}".format(**cfg)',
  "Use the form postgres://USER:PASS@HOST:PORT/db in the config.",
  "amqp://guest:secret@localhost:5672/",
  "mongodb://admin:passwd@127.0.0.1:27017/app",
  "DATABASE_URL=postgres://postgres:your-password@localhost:5432/app",
  'MYSQL_URL="mysql://root:your_password_here@db:3306/shop"',
];

test("everyday templates for a database link stay quiet", () => {
  for (const line of TEMPLATE_LINES) {
    assert.deepEqual(detect(line), [], line);
  }
});
