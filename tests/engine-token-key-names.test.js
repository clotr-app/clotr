"use strict";

// A storage-key constant holds the name a token is kept under, like `const TOKEN_KEY = 'app:authToken';`.
// That name isn't a secret, but a random-looking or passphrase-looking value after a `_KEY` name still is.
// All values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

const KEY_NAMES = [
  "const TOKEN_KEY = 'app:authToken';",
  "const ACCESS_TOKEN_KEY = 'auth.accessToken';",
  'const token_key = "auth_token";',
  'const REFRESH_TOKEN_KEY = "app:refreshToken";',
  "const SESSION_KEY = 'myapp.session';",
  'const AUTH_KEY = "user_auth";',
  "const session_key = 'app_session_id';",
  'export const ID_TOKEN_KEY = "oidc.idToken";',
  "const access_token_key = 'access_token';",
  'const AUTH_TOKEN_KEY = "authToken";',
  "const token_key = 'store:auth:token';",
  'TOKEN_KEY = "jwtToken"',
];

for (const text of KEY_NAMES) {
  test(`a storage key's name after a _KEY name stays quiet: ${text}`, () => {
    assert.deepEqual(detect(text), {});
  });
}

const SECRETS = [
  ['const TOKEN_KEY = "copper-meadow-falcon-v2";', "copper-meadow-falcon-v2"],
  ["const TOKEN_KEY = 'Xq7vR2mK9pLw4TzB';", "Xq7vR2mK9pLw4TzB"],
  ['const token_key = "Tq8!zW3r#Lp5";', "Tq8!zW3r#Lp5"],
  ["const SESSION_KEY = 'b7Hk2Qz9Vx4Mn6Rt';", "b7Hk2Qz9Vx4Mn6Rt"],
  ['const ACCESS_TOKEN_KEY = "token:Q8r2Xv7KpL4m";', "token:Q8r2Xv7KpL4m"],
  // A key name only reads as a name under a token's, auth's or session's _KEY constant.
  ["const API_KEY = 'authToken';", "authToken"],
  ['const SECRET_KEY = "session_token";', "session_token"],
  ["password_key = 'auth_token'", "auth_token"],
];

for (const [text, value] of SECRETS) {
  test(`a secret after a _KEY name is still found: ${text}`, () => {
    const found = Object.values(detect(text)).flat();
    assert.ok(found.includes(value), `${JSON.stringify(text)} → ${JSON.stringify(detect(text))}`);
  });
}

// Letters-only chunks with one token word, joined by "_", ".", ":", capitals or "-", after TOKEN_KEY. Random letters
// and dictionary passphrases are both secrets, though they split into chunks like a key name does. Made up from a
// fixed seed, 40 of each.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = [
  "river",
  "blue",
  "stone",
  "maple",
  "orbit",
  "velvet",
  "harbor",
  "cinder",
  "lantern",
  "copper",
  "meadow",
  "falcon",
];
const TOKEN_WORDS = ["token", "auth", "session", "jwt"];
const LETTERS = "bcdfghjklmnpqrstvwxz";
const chunk = () => Array.from({ length: 4 + Math.floor(rnd() * 4) }, () => pick(LETTERS)).join("");
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const JOINS = {
  _: (ws) => ws.join("_"),
  ".": (ws) => ws.join("."),
  ":": (ws) => ws.join(":"),
  camel: (ws) => ws[0] + ws.slice(1).map(cap).join(""),
  "-": (ws) => ws.join("-"),
};

for (const kind of ["dictionary passphrase", "random-letter chunks"]) {
  for (const [join, joinWords] of Object.entries(JOINS)) {
    const values = [];
    for (let i = 0; i < 40; i++) {
      const ws = Array.from({ length: 3 }, () => (kind[0] === "d" ? pick(WORDS) : chunk()));
      ws.splice(Math.floor(rnd() * 4), 0, pick(TOKEN_WORDS));
      values.push(joinWords(ws));
    }
    test(`${kind} joined by ${join} after TOKEN_KEY is found`, () => {
      const missed = values.filter(
        (v) =>
          !Object.values(detect(`const TOKEN_KEY = '${v}';`))
            .flat()
            .some((m) => m.includes(v)),
      );
      assert.deepEqual(missed, []);
    });
  }
}
