// A link right after the word password is read as the password and covered, as 1.6.3 reads it, so a reset token
// in it is covered too. A link with no code in it warns as well. A setting's own line sets a link as the password
// the same way ("password: https://…", "password=https://…"), and so does "my password is https://…". Every host
// here is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("./load-engine.js")("rules", "detect");
const { detect, redact } = globalThis.Clotr;

const passwords = (text) =>
  detect(text)
    .filter((result) => result.id === "password")
    .flatMap((result) => result.matches);

const RESET_SENTENCES = [
  "Reset your password https://portal.wibblecorp.io/reset",
  "Reset your password: https://portal.wibblecorp.io/reset",
  "Reset password https://portal.wibblecorp.io/reset",
  "Reset your password http://portal.wibblecorp.io/reset",
  "Reset your password www.wibblecorp.io/reset",
  "reset ur password https://portal.wibblecorp.io/reset pls",
  "Here's the link to reset the password https://help.tailspin.co/reset-password",
  "Set a new password https://id.fabrikam.app/setup",
  "Create a password https://signup.example.org/start",
  "Choose a new password: https://id.fabrikam.app/new",
  "Update your password https://my.northwind.dev/settings/security",
  "Change password https://portal.wibblecorp.io/account",
  "forgot password https://www.wibblecorp.io/forgot-password",
  "Log in with your new password https://app.tailspin.co/login",
  "Reset your password\nhttps://portal.wibblecorp.io/reset",
  "Hi Sam,\n\nWe got a request to reset your password https://accounts.example.com/reset?t=x9\n\nThanks",
  "Hi Sam,\n\nReset your password: https://login.contoso-mail.net/reset/7f3a\n\nThe link works for an hour.",
];

// What of a link 1.6.3 reads as the password: after "password:" the whole link up to 128 characters, and in a
// sentence ("Reset your password https://…") its first 64.
function linkRead(text, link) {
  if (text.includes("password: ")) return link.length <= 128 ? link : "";
  return link.slice(0, 64);
}

// A value under a token's own name in the query is found on its own, wherever the link is.
const TOKEN_NAMED = /[?#&]\w*token=/;

// Whether 1.6.3 finds the token: in the part of the link it reads, or under a token's name. A token past that
// part of a long link is a todo below.
function tokenRead(text, link, token) {
  return linkRead(text, link).includes(token) || TOKEN_NAMED.test(link);
}

function linkIn(text) {
  return /(?:https?:\/\/|www\.)\S+/.exec(text)[0];
}

test("a link right after the word password in a sentence is covered, as 1.6.3 covers it", () => {
  for (const text of RESET_SENTENCES) assert.deepEqual(passwords(text), [linkIn(text)], text);
});

test("a link after more words or a question mark stays quiet, as on 1.6.3", () => {
  for (const text of [
    "To reset your password, go to https://accounts.example.com/recover",
    "Forgot your password? https://login.contoso-mail.net/forgot",
    "Password reset https://bank.example.co.uk/reset",
  ]) {
    assert.deepEqual(passwords(text), [], text);
  }
});

test("a link set as the password on a setting's line is still found", () => {
  const link = "https://portal.wibblecorp.io/reset";
  for (const text of [
    `password: ${link}`,
    `password=${link}`,
    `PASSWORD=${link}`,
    `password = ${link}`,
    `db_password: ${link}`,
    `"password": "${link}"`,
    `  password: ${link}`,
    `- password: ${link}`,
    `my password is ${link}`,
    `the password is ${link}`,
  ]) {
    assert.deepEqual(passwords(text), [link], text);
  }
});

test("a reset sentence still warns on a password or a login link next to it", () => {
  const told = "Reset your password. Your temporary password is Fluffy123!";
  assert.deepEqual(passwords(told), ["Fluffy123"]);
  const login = "Reset your password https://sam:Fluffy123@portal.wibblecorp.io/reset";
  assert.ok(
    detect(login).some((result) => result.id === "connection_string"),
    login,
  );
  assert.ok(!redact(login, detect(login)).includes("Fluffy123"), login);
  // A token named in the link's query is found on its own too, and covered with the link.
  const token = "Click here to reset your password https://id.fabrikam.app/forgot?token=abc123";
  assert.ok(passwords(token).includes("abc123"), token);
  assert.equal(redact(token, detect(token)), "Click here to reset your password [REDACTED PASSWORD OR SECRET]");
});

// ---------- A token inside the link ----------

// A token in a reset or sign-in link is the secret: anyone holding the link can set the password. Made-up
// tokens in the shapes reset links use: 40 hex, 32 letters and digits, a Django token, a UUID, and 64 hex, long
// enough to run past the 64 characters 1.6.3 reads of a link in a sentence.
const TOKENS = [
  "7c2e9a41f05b3d68e1a7c94f2b06d58e3a19c7f4",
  "Hq7XkR2mWv9TzLp4NcB6sYd3FgJ8aEu5",
  "c9v0z3-4be1a7d92f6c08e35a1d7b4c9e2f60a8",
  "3f9c1e7a-52d4-4b8e-a6f1-0d93c27e5b84",
  "e4b1c8f27a9d03e65f1b7c2a94d8e06f3b5a1c79d2e8f04a6b3c7e91d5f2a08b",
];
// Where the token sits in the link.
const PLACES = {
  "the path": (host, token) => `https://${host}/reset/${token}`,
  "a two-part path": (host, token) => `https://${host}/reset/MQ/${token}/`,
  "a short path": (host, token) => `https://${host}/r/${token}`,
  "?code=": (host, token) => `https://${host}/reset?code=${token}`,
  "?key= and &login=": (host, token) => `https://${host}/wp-login.php?action=rp&key=${token}&login=sam`,
  "?t=": (host, token) => `https://${host}/magic?t=${token}`,
  "oobCode=": (host, token) => `https://${host}/__/auth/action?mode=resetPassword&oobCode=${token}`,
  "?token=": (host, token) => `https://${host}/reset?token=${token}`,
  "#token=": (host, token) => `https://${host}/reset#token=${token}`,
  "?reset_token=": (host, token) => `https://${host}/reset?reset_token=${token}`,
};
const HOSTS = ["portal.wibblecorp.io", "id.fabrikam.app", "login.otterbank.co"];
// The link right after the word password, with and without a colon.
const AFTER_PASSWORD = [
  (link) => `Reset your password ${link}`,
  (link) => `Choose a new password: ${link}`,
  (link) => `is this legit? it says click to reset your password ${link}`,
  (link) => `Reset your password: ${link}`,
  (link) => `Hi Sam,\n\nReset your password: ${link}\n\nThe link works for an hour.`,
];

// What of the token Cover it leaves: any 6 characters of it in a row.
function leftOfToken(token, hidden) {
  for (let i = 0; i + 6 <= token.length; i++) if (hidden.includes(token.slice(i, i + 6))) return token.slice(i, i + 6);
  return "";
}

// Every link and its sentence, with whether 1.6.3 finds the token.
function tokenLinks() {
  const links = [];
  let n = 0;
  for (const [place, makeLink] of Object.entries(PLACES)) {
    for (const token of TOKENS) {
      const link = makeLink(HOSTS[n % HOSTS.length], token);
      const text = AFTER_PASSWORD[n % AFTER_PASSWORD.length](link);
      n++;
      links.push({ place, token, text, read: tokenRead(text, link, token) });
    }
  }
  return links;
}

test("a token in a reset or sign-in link right after the word password is found and covered whole", () => {
  for (const { place, token, text, read } of tokenLinks()) {
    if (!read) continue;
    const found = detect(text);
    assert.ok(found.length > 0, `${place}: ${text}`);
    assert.equal(leftOfToken(token, redact(text, found)), "", `${place}: ${text}`);
  }
});

test("a token past what 1.6.3 reads of a long link is covered whole", { todo: true }, () => {
  for (const { place, token, text, read } of tokenLinks()) {
    if (read) continue;
    assert.equal(leftOfToken(token, redact(text, detect(text))), "", `${place}: ${text}`);
  }
});

test("every sentence shape finds the token, in the path and in the query", () => {
  for (const say of AFTER_PASSWORD) {
    for (const makeLink of [PLACES["the path"], PLACES["?code="]]) {
      const text = say(makeLink("id.fabrikam.app", TOKENS[1]));
      assert.equal(leftOfToken(TOKENS[1], redact(text, detect(text))), "", text);
    }
  }
});

// The link a few words after the word password, or on the next line of an email. A token named in the query
// is still found there.
const LATER_IN_THE_SENTENCE = [
  (link) => `Sign in to change your password at ${link}`,
  (link) => `Hi Sam,\nWe got a request to reset your password.\n${link}\nThis link expires in 1 hour.`,
];

test("a token named in the query is found when the link isn't right after the word password", () => {
  for (const say of LATER_IN_THE_SENTENCE) {
    for (const place of ["?token=", "#token=", "?reset_token="]) {
      const text = say(PLACES[place]("portal.wibblecorp.io", TOKENS[0]));
      assert.equal(leftOfToken(TOKENS[0], redact(text, detect(text))), "", text);
    }
  }
});

test("a token in the path isn't found yet when the link isn't right after the word password", { todo: true }, () => {
  for (const say of LATER_IN_THE_SENTENCE) {
    const text = say(PLACES["the path"]("portal.wibblecorp.io", TOKENS[0]));
    assert.equal(leftOfToken(TOKENS[0], redact(text, detect(text))), "", text);
  }
});

// Short made-up tokens of mixed-case letters, which a looser word check read as words.
const MIXED_CASE_TOKENS = [
  "vrjoNbHmaxcJvDv1",
  "hSgYzpwCOwqnilO7",
  "Z0_OuRqJygDBfQJS",
  "vSHjt3-GZDnmbUoU",
  "qu8_j-jyPHWvwtTv",
  "jVAWHEVgyIbJBqH4",
  "UMCyLOpejKZUfPO4",
];

test("a short token of mixed-case letters is found, not read as words", () => {
  for (const token of MIXED_CASE_TOKENS) {
    for (const makeLink of [PLACES["the path"], PLACES["?code="]]) {
      const text = `Reset your password ${makeLink("id.fabrikam.app", token)}`;
      assert.equal(leftOfToken(token, redact(text, detect(text))), "", text);
    }
  }
});

test("a reset link of words, numbers, ids and tracking values is covered too, as 1.6.3 covers it", () => {
  for (const link of [
    "https://help.wibblecorp.io/kb/OAuth2-Password-Reset-Guide",
    "https://help.wibblecorp.io/WiFi-Password-Reset-Steps",
    "https://help.wibblecorp.io/iPhone-Password-Reset-Instructions",
    "https://www.wibblecorp.io/MyAccount/ChangePasswordAndSecurityQuestions",
    "https://wibblecorp.b2clogin.com/wibblecorp.onmicrosoft.com/B2C_1_SignUpSignIn2/oauth2/v2.0/authorize",
    "https://help.wibblecorp.io/articles/360001234567-How-to-reset-your-password",
    "https://portal.wibblecorp.io/help/kb/KB0012345-reset-password-self-service",
    "https://accounts.example.com/recover?utm_source=newsletter_2024_11_25&utm_medium=email",
    "https://store.example.org/customer/account/forgotpassword/?utm_campaign=PasswordReset_Q4_2024",
    "https://id.fabrikam.app/u/reset-password/request/Username-Password-Authentication",
    "https://wibblecorp.b2clogin.com/wibblecorp.onmicrosoft.com/B2C_1_signupsignin1/oauth2/v2.0/authorize",
    "https://login.contoso-lab.net/common/oauth2/v2.0/authorize?client_id=6731de76-14a6-49ae-97bc-6eba6914391e",
    "https://login.otterbank.co/forgot?source=ios_app_v5_12_0&device=iPhone15",
  ]) {
    for (const text of [`Reset your password ${link}`, `Choose a new password: ${link}`]) {
      assert.deepEqual(passwords(text), [linkRead(text, link)], text);
    }
  }
});

test("the link is covered with the token in it, as 1.6.3 covers it", () => {
  const link = `https://id.fabrikam.app/reset/${TOKENS[1]}`;
  const text = `Reset your password ${link}`;
  assert.deepEqual(passwords(text), [link]);
  assert.equal(redact(text, detect(text)), "Reset your password [REDACTED PASSWORD OR SECRET]");
});

// ---------- Short, padded and plain tokens ----------

// Tokens a reset link uses that aren't 16 letters and digits: short codes, base64 with its + / and = (raw or
// URL-escaped), dotted and tilde codes, and tokens of only digits or only letters. Every one is made up.
const SHORT_TOKENS = ["4hTq9w", "Rk2PzW7n", "VQ3MXK", "t7z4kq", "B5D19E", "Xp8vLm2Rq4Tz"];
const PADDED_TOKENS = [
  "Lq3V+8pZn/Kd7RwT2yHc4u==",
  "Hm4R+Tw/9Qz2Lp7Kx6Vb3Nc8Fd5Gs1Jy=",
  "Wd7Kp2%2BQx9Tz4Lm8Rv%2F3Nc6Hb5Jy1Fs%3D%3D",
  "M.C412_BAY.2.U.7d3e91a4-5b2c-48f6-a0e9-3c7d1b5f9a26",
  "Rv9QzT4LpX2K.Wm7Hc3Nb8Fd~5Gs1Jy6Ta",
];
const PLAIN_TOKENS = ["604913", "48207156", "93061847205168342957", "qwzvhd", "kplmrtxa", "ZQWHKD", "hqTzWvPk"];

// Where a token sits in a reset link, from the shapes services send.
const TOKEN_PLACES = {
  "?token=": (token) => `https://id.fabrikam.app/self-service/recovery?flow=7e2d&token=${token}`,
  "?code= and &email=": (token) =>
    `https://id.fabrikam.app/confirm-forgot-password?code=${token}&email=sam%40example.com`,
  "?key= and &login=": (token) => `https://id.fabrikam.app/wp-login.php?action=rp&key=${token}&login=sam`,
  "#access_token=": (token) => `https://id.fabrikam.app/update-password#access_token=${token}&type=recovery`,
  "?ticket=": (token) => `https://id.fabrikam.app/lo/reset?ticket=${token}`,
  "after /reset-password/": (token) => `https://id.fabrikam.app/signin/reset-password/${token}`,
  "after /password/reset/, then &email=": (token) =>
    `https://id.fabrikam.app/password/reset/${token}?email=sam%40example.com`,
  "after a short id": (token) => `https://id.fabrikam.app/accounts/reset/MTIz/${token}/`,
  "after a one-letter path": (token) => `https://id.fabrikam.app/r/${token}`,
};
const SENTENCES = [
  (link) => `Reset your password ${link}`,
  (link) => `Choose a new password: ${link}`,
  (link) => `can you check this one for me, reset password ${link}`,
  (link) => `Hi Sam,\n\nReset your password: ${link}\n\nThe link works for an hour.`,
];

// Whether Cover it hides the whole token: none of it in a row, and no run of 4 letters or digits from it.
function coveredWhole(token, text) {
  const hidden = redact(text, detect(text));
  if (hidden.includes(token)) return false;
  return token
    .split(/[^A-Za-z\d]+/)
    .filter((piece) => piece.length >= 4)
    .every((piece) => !hidden.includes(piece));
}

// Every token in every place, with its sentence and whether 1.6.3 reads the whole link.
function placedTokens(tokens) {
  const placed = [];
  let n = 0;
  for (const token of tokens) {
    for (const [place, makeLink] of Object.entries(TOKEN_PLACES)) {
      const link = makeLink(token);
      const text = SENTENCES[n++ % SENTENCES.length](link);
      placed.push({ place, token, text, read: tokenRead(text, link, token) });
    }
  }
  return placed;
}

function assertCoveredEverywhere(tokens) {
  for (const { place, token, text, read } of placedTokens(tokens)) {
    if (read) assert.ok(coveredWhole(token, text), `${place}: ${text}`);
  }
}

test("a token under 16 characters in a reset link is covered whole", () => {
  assertCoveredEverywhere(SHORT_TOKENS);
});

test("a token with base64's + / =, URL escapes, dots or tildes is covered whole", () => {
  assertCoveredEverywhere(PADDED_TOKENS);
});

test("a token of only digits or only letters in a reset link is covered whole", () => {
  assertCoveredEverywhere(PLAIN_TOKENS);
});

test("a short, padded or plain token past what 1.6.3 reads of a long link is covered whole", { todo: true }, () => {
  for (const { place, token, text, read } of placedTokens([...SHORT_TOKENS, ...PADDED_TOKENS, ...PLAIN_TOKENS])) {
    if (!read) assert.ok(coveredWhole(token, text), `${place}: ${text}`);
  }
});

// A setting's line takes the link as the password ("Choose a new password: https://…"), so a token named in its
// query is covered with it.
test("after a password's colon, a token named in the link's query is covered whole", () => {
  for (const token of ["93061847205168342957", "Rk2PzW7n", "4hTq9w", "Lq3V+8pZn/Kd7RwT2yHc4u==", PADDED_TOKENS[2]]) {
    for (const link of [
      `https://id.fabrikam.app/reset?token=${token}`,
      `https://id.fabrikam.app/login?code=${token}`,
      `https://id.fabrikam.app/Account/ResetPassword?userId=3c9e1f2a-7b4d-4e8a-9c0f-1a2b3c4d5e6f&code=${token}`,
    ]) {
      for (const text of [`Choose a new password: ${link}`, `Reset your password: ${link}`, `password: ${link}`]) {
        assert.ok(coveredWhole(token, text), text);
      }
    }
  }
});

// The reset's own pages, help pages and article ids that sit where a token would, all made up.
test("a reset page, a help slug or an article id where a token would sit is covered too, as 1.6.3 covers it", () => {
  for (const link of [
    "https://id.fabrikam.app/password/reset/confirm",
    "https://id.fabrikam.app/reset/ChangePassword",
    "https://id.fabrikam.app/reset-password/request",
    "https://accounts.fabrikam.app/ResetPasswordConfirmation",
    "https://portal.wibblecorp.io/HRPortal/ESSPasswordResetHelp",
    "https://support.wibblecorp.io/en-us/102656",
    "https://help.wibblecorp.io/questions/12345678/how-do-i-reset-a-forgotten-mysql-root-password",
    "https://docs.fabrikam.app/account/passwords/resetting-a-forgotten-password",
  ]) {
    for (const text of [`Reset your password ${link}`, `Choose a new password: ${link}`]) {
      assert.deepEqual(passwords(text), [linkRead(text, link)], text);
    }
  }
});
