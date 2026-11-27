// A password in any scheme://user:password@host link is found as a connection string and covered whole, not only
// in the database and web links. Text that only looks like a link login stays quiet.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect } = globalThis.Clotr;

function matchesOf(text, id) {
  return detect(text)
    .filter((result) => result.id === id)
    .flatMap((result) => result.matches);
}

// ---------- Real passwords ----------

test("a real password in any link is found as a connection string, whole", () => {
  for (const link of [
    "smb://alex:hunter2!@nas.example.com/share",
    "ssh://alex:sunshine9@server.example.com",
    "ssh://alex:Tr0ub&dor3@server.example.com",
    "ssh://alex:p#ssw0rd@server.example.com",
    "ssh://alex:Pa@ss99@server.example.com",
    "ldap://alex:hunter2!@ldap.example.com/dc=example,dc=com",
    "svn+ssh://alex:Tr0ub&dor3@svn.example.com/repo",
    "rtsp://admin:wibblefrogpond@192.168.1.64:554/stream1",
  ]) {
    assert.deepEqual(matchesOf(`mount it with ${link} please`, "connection_string"), [link], link);
  }
});

test("the driver suffix and the database links still read as before", () => {
  for (const link of [
    "postgresql+psycopg2://alex:Tr0ub&dor3@db.example.com/app",
    "oracle+cx_oracle://alex:hunter2!@ora.example.com:1521/orcl",
    "redis://:Tr0ub4dor3@cache.example.com:6379",
  ]) {
    assert.deepEqual(matchesOf(link, "connection_string"), [link], link);
  }
});

test("the email reading leaves a link's password to the connection rule", () => {
  for (const link of ["ssh://alex:sunshine9@server.example.com", "ssh://alex:p%40ss123@server.example.com"]) {
    assert.deepEqual(matchesOf(link, "email"), [], link);
  }
});

// ---------- Stand-ins and local logins ----------

test("a stand-in password stays quiet in any link", () => {
  for (const link of [
    "ssh://alex:password@server.example.com",
    "smb://alex:changeme@nas.example.com/share",
    "mqtt://alex:changeme@broker.example.com:1883",
  ]) {
    assert.deepEqual(detect(link), [], link);
  }
});

test("a database's default login on this machine stays quiet, as an email too", () => {
  const link = "postgres://postgres:postgres@host.docker.internal:5432/app";
  assert.deepEqual(matchesOf(link, "connection_string"), []);
  assert.deepEqual(matchesOf(link, "email"), []);
});

// ---------- Link-shaped text that isn't a login ----------

test("a file link isn't a login", () => {
  const link = "file://C:/Users/alex/Pictures/icon@2x.png";
  assert.deepEqual(matchesOf(link, "connection_string"), []);
});

test("an extension's page isn't a login", () => {
  for (const link of [
    "chrome-extension://kbfnbcaeplbcioakkpcpgfkobkghlhen/popup.html#tab:share@team.example.com",
    "moz-extension://4b2f9c1e-7d3a-4e8b-9f21-a6c5d0e8b713/options.html#tab:share@team.example.com",
  ]) {
    assert.deepEqual(matchesOf(link, "connection_string"), [], link);
  }
});

test("a scheme without // isn't a login", () => {
  for (const text of [
    "INFO:root:alex.rivera@example.com signed in",
    "mailto:alex.rivera@example.com",
    "about:config?filter=alex:sunshine9@server.example.com",
  ]) {
    assert.deepEqual(matchesOf(text, "connection_string"), [], text);
  }
  assert.deepEqual(matchesOf("INFO:root:alex.rivera@example.com signed in", "email"), ["alex.rivera@example.com"]);
});

test("a port and a path, or a repo and a tag, isn't a login", () => {
  for (const text of [
    "svn://svn.example.com:3690/repo/trunk@1234",
    "pip install git+ssh://git@github.com:acme/tools.git@v1.2.0",
    "ssh://deploy@build.example.com:/srv/app/node_modules/@acme/ui",
  ]) {
    assert.deepEqual(matchesOf(text, "connection_string"), [], text);
  }
});

// ---------- A link that isn't a login, right before one ----------
// Compact JSON and comma lists put links side by side with no space, so a link that isn't a login can't hide the
// login after it.

test("a link that isn't a login doesn't hide a login right after it", () => {
  for (const [text, login] of [
    [
      '{"WS_URL":"ws://localhost:8080/ws","DATABASE_URL":"postgres://admin:hunter2!zz@db.wibblecorp.io:5432/app"}',
      "postgres://admin:hunter2!zz@db.wibblecorp.io:5432/app",
    ],
    [
      '{"WS_URL":"ws://localhost:8080/ws","DATABASE_URL":"postgres://admin:maple2093otter@10.2.3.4:5432/app"}',
      "postgres://admin:maple2093otter@10.2.3.4:5432/app",
    ],
    [
      '{"repo":"ssh://git@github.com:acme/app.git","db":"postgres://admin:hunter2!zz@db.wibblecorp.io/app"}',
      "postgres://admin:hunter2!zz@db.wibblecorp.io/app",
    ],
    [
      '{"files":"rsync://backup@nas:/vol1/","db":"mysql://root:Wibble#Frog9@mysql.wibblecorp.io/shop"}',
      "mysql://root:Wibble#Frog9@mysql.wibblecorp.io/shop",
    ],
    [
      "SERVICES=tcp://broker:9092/,redis://:Fr0g!pond77@cache.wibblecorp.io:6379",
      "redis://:Fr0g!pond77@cache.wibblecorp.io:6379",
    ],
  ]) {
    assert.deepEqual(matchesOf(text, "connection_string"), [login], text);
    assert.deepEqual(matchesOf(text, "email"), [], text);
  }
});

test("Cover it leaves nothing of a login after a link that isn't one", () => {
  const text = '{"WS_URL":"ws://localhost:8080/ws","DATABASE_URL":"postgres://admin:hunter2!zz@db.wibblecorp.io/app"}';
  const covered = globalThis.Clotr.redact(text, detect(text));
  assert.ok(!covered.includes("hunter2"), covered);
});

// One crafted run of links that aren't logins, with no space, mustn't make each one rescan the rest of the run.
test("links that aren't logins, side by side in one long run, stay linear", () => {
  const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");
  const findLogins = globalThis.Clotr.PATTERNS.find((p) => p.id === "connection_string").find;
  const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  for (const unit of ["ws://a:1/@b", "ssh://git@h:a/b@c;"]) {
    const small = repeat(unit, 4 * 1024);
    const big = repeat(unit, 64 * 1024);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => findLogins(small),
          () => findLogins(big),
        ),
      (s, b) => grewMoreThan(s, b, 32),
    );
    const ratio = slow ? (slow[1].wall / slow[0].wall).toFixed(1) : "";
    assert.ok(!slow, `connection_string on ${JSON.stringify(unit)} repeated: time grew ${ratio}× for 16× the input`);
  }
});

// ---------- A stand-in login, right before a real one ----------
// A login with a stand-in password isn't reported, so it can't hide a real login later in the same run.

test("a stand-in login doesn't hide a real login right after it", () => {
  for (const [text, login] of [
    [
      "SERVICES=postgres://user:password@localhost:5432/db,amqp://admin:fennel4274^@localhost/app",
      "amqp://admin:fennel4274^@localhost/app",
    ],
    [
      "DBS=redis://:secret@cache:6379;postgres://admin:hunter2!zz@db.wibblecorp.io/app",
      "postgres://admin:hunter2!zz@db.wibblecorp.io/app",
    ],
    [
      "?primary=postgres://sam:pass@db/app&replica=mysql://root:maple2093otter@10.2.3.4/shop",
      "mysql://root:maple2093otter@10.2.3.4/shop",
    ],
    [
      '{"example":"postgres://app:%s@db/app","db":"mysql://root:Wibble#Frog9@mysql.wibblecorp.io/shop"}',
      "mysql://root:Wibble#Frog9@mysql.wibblecorp.io/shop",
    ],
    [
      "postgres://app:$(DB_PASSWORD)@db/app|sftp://deploy:Fr0g!pond77@files.wibblecorp.io",
      "sftp://deploy:Fr0g!pond77@files.wibblecorp.io",
    ],
    [
      "postgres://postgres:postgres@localhost:5432/dev,postgres://admin:hunter2!zz@db.wibblecorp.io/app",
      "postgres://admin:hunter2!zz@db.wibblecorp.io/app",
    ],
  ]) {
    assert.deepEqual(matchesOf(text, "connection_string"), [login], text);
    assert.deepEqual(matchesOf(text, "email"), [], text);
  }
});

test("Cover it leaves nothing of a real login after a stand-in one", () => {
  const text = "SERVICES=postgres://user:password@localhost:5432/db,amqp://admin:fennel4274^@localhost/app";
  const covered = globalThis.Clotr.redact(text, detect(text));
  assert.ok(!covered.includes("fennel"), covered);
});

// A real login first still covers the whole run, the stand-in after it too.
test("a real login before a stand-in one is covered to the end of the run", () => {
  const text = "SERVICES=amqp://admin:fennel4274^@localhost/app,postgres://user:password@localhost:5432/db";
  assert.deepEqual(matchesOf(text, "connection_string"), [text.slice("SERVICES=".length)]);
});

test("stand-in logins, side by side in one long run, stay linear", () => {
  const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");
  const findLogins = globalThis.Clotr.PATTERNS.find((p) => p.id === "connection_string").find;
  const repeat = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  for (const unit of ["postgres://u:password@h/d,", "redis://:%s@h;"]) {
    const small = repeat(unit, 4 * 1024);
    const big = repeat(unit, 64 * 1024);
    const slow = grewEveryTime(
      () =>
        bestOfPair(
          () => findLogins(small),
          () => findLogins(big),
        ),
      (s, b) => grewMoreThan(s, b, 32),
    );
    const ratio = slow ? (slow[1].wall / slow[0].wall).toFixed(1) : "";
    assert.ok(!slow, `connection_string on ${JSON.stringify(unit)} repeated: time grew ${ratio}× for 16× the input`);
  }
});

// ---------- Passwords with a space ----------

test("a password with a space in a link is found as a connection string, whole", () => {
  for (const link of [
    "sftp://alex:my pass@files.example.com",
    "ssh://alex:correct horse battery@server.example.com",
    "smb://alex:Tr0ub dor3!@nas.example.com/share",
    "postgres://alex:my pass@db.example.com:5432/app",
    "rtsp://admin:my pass@192.168.1.64:554/stream1",
    "smb://alex:my pass@nas/share",
  ]) {
    assert.deepEqual(matchesOf(`mount it with ${link} please`, "connection_string"), [link], link);
  }
});

test("Cover it leaves no word of a spaced password", () => {
  for (const [link, password] of [
    ["sftp://alex:my pass@files.example.com", "my pass"],
    ["ssh://alex:correct horse battery@server.example.com", "correct horse battery"],
    ["smb://alex:Tr0ub dor3!@nas.example.com/share", "Tr0ub dor3!"],
  ]) {
    const covered = globalThis.Clotr.redact(link, detect(link));
    for (const word of password.split(" ")) assert.ok(!covered.includes(word), `${word} survives in ${covered}`);
  }
});

test("the email reading leaves a spaced password to the connection rule", () => {
  for (const link of ["sftp://alex:my pass@files.example.com", "ssh://alex:correct horse battery@server.example.com"]) {
    assert.deepEqual(matchesOf(link, "email"), [], link);
  }
});

test("a link and then an email on the same line stays an email", () => {
  const text = "see ftp://files.example.com and mail sam@example.com";
  assert.deepEqual(matchesOf(text, "connection_string"), []);
  assert.deepEqual(matchesOf(text, "email"), ["sam@example.com"]);
});

test("a link with no login, then words and an @ handle, stays quiet", () => {
  for (const text of ["https://example.com thanks @sam", "https://example.com:8443 thanks @sam"]) {
    assert.deepEqual(detect(text), [], text);
  }
});

test("'my password' with a space isn't a stand-in, so it warns as it did before", () => {
  // The stand-in check only knows single words. Before, this warned as the email password@server.example.com.
  const link = "ssh://alex:my password@server.example.com";
  assert.deepEqual(matchesOf(link, "connection_string"), [link]);
  // A one-word host with nothing after it isn't read as a host, so this stays quiet, as before.
  assert.deepEqual(detect("ssh://alex:my password@host"), []);
});

// ---------- Where a spaced run isn't a password ----------

function staysAnEmail(text) {
  assert.deepEqual(matchesOf(text, "connection_string"), [], text);
  assert.deepEqual(matchesOf(text, "email"), ["sam@example.com"], text);
}

test("a spaced password stays on one line", () => {
  staysAnEmail("ssh://deploy:in the vault\nsam@example.com wrote");
  staysAnEmail("ssh://deploy:in the\tvault sam@example.com");
});

test("a spaced password holds no link or quote marks", () => {
  staysAnEmail("ssh://alex:notes/today and sam@example.com");
  staysAnEmail("ssh://alex:what?ask sam@example.com");
  staysAnEmail("ssh://alex:see #ops or sam@example.com");
  staysAnEmail('{"url": "ssh://alex:x", "email": "sam@example.com"}');
});

test("a spaced password is at most 4 words and 40 characters", () => {
  staysAnEmail("ssh://alex:the key is with sam@example.com");
  staysAnEmail("ssh://alex:averyveryverylongfirstword anotherlongword sam@example.com");
});

test("a sentence that goes on isn't a password", () => {
  staysAnEmail("ssh://alex:hunter2. Then ask sam@example.com");
  staysAnEmail("ssh://alex:hi, ask sam@example.com");
});

test("a port isn't a spaced password", () => {
  staysAnEmail("see https://example.com:8443 and mail sam@example.com");
  staysAnEmail("open http://localhost:3000 then ping sam@example.com");
});

test("an @ handle isn't a host", () => {
  for (const text of ["ssh://alex:ping me@sam thanks", "ssh://alex:ping me@sam"]) {
    assert.deepEqual(matchesOf(text, "connection_string"), [], text);
  }
});
