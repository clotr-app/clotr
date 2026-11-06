"use strict";

// Developer text (settings, code, logs, git output and version strings) stays quiet, while the real secret or
// personal detail in the same shapes still fires. Every value here is made up.

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

function expectQuiet(lines) {
  const loud = [];
  for (const line of lines) {
    const found = detect(line);
    if (Object.keys(found).length) loud.push(`${JSON.stringify(line)} → ${JSON.stringify(found)}`);
  }
  assert.deepEqual(loud, [], "these should stay quiet");
}

function expectKinds(cases) {
  const missed = [];
  for (const [line, kind] of cases) {
    const found = detect(line);
    if (!found[kind]) missed.push(`${JSON.stringify(line)} should be ${kind}, got ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, [], "these should still fire");
}

// A random-looking body made of obviously-fake parts.
const body = "Qm7vX2pL" + "9tR4wK8n";
// A cloud storage key's shape: 40 base64 characters.
const cloudKey = body + "Zq3Hb6Yc1Ld5" + "Nf0Jg8PsTw4E";

test("a setting named after a password or token that holds a number, flag, type or name is quiet", () => {
  expectQuiet([
    "pin_memory=True",
    "DataLoader(train_ds, batch_size=64, shuffle=True, pin_memory=True)",
    "token_count = 1523",
    "token_limit: 4096",
    "token_budget = 8000",
    "token_expiry = 3600",
    "TOKEN_TTL=3600",
    "token_type: Bearer",
    "pass_rate: 0.9734",
    "pass_fail: Pass",
    "PASSWORD_RESET_TIMEOUT=259200",
    "password_hash_algorithm: Argon2id",
    "secret_type: Opaque",
    "api_key_header: X-Api-Key",
    "api_key_required: True",
    "access_token_lifetime: 3600s",
    "password_field: Password1",
    "eos_token_id: 50256",
    "token_type_ids = None",
    "secret_name: db-credentials",
    "password_policy: Strict",
    "SESSION_TOKEN_TIMEOUT=30m",
    "password: None",
    "password: null",
    "PASSWORD_HASHERS = DEFAULT_HASHERS",
    "password: !vault |",
    "db_password: !Ref DbPasswordParam",
    "secret: kubernetes.io/service-account-token",
  ]);
});

test("code that names or computes a secret rather than holding one is quiet", () => {
  expectQuiet([
    "pad_token = tokenizer.eos_token",
    "tokenizer.pad_token = tokenizer.eos_token",
    "secret = Secret.from_name('openai')",
    'export const API_KEY_HEADER = "x-api-key";',
    'self.api_key = api_key or os.getenv("SERVICE_API_KEY")',
    'private static final String TOKEN_PREFIX = "Bearer ";',
    "let session_token = generate_token(32);",
    "UPDATE users SET password = crypt($1, gen_salt('bf')) WHERE id = $2;",
    "token = generateToken(user)",
    'token = response.json()["access_token"]',
    "token: state.auth.token,",
    "password: hashedPassword,",
    "token = jwt.encode(payload, key)",
    "password = user.password",
    "access_token = tokens['access_token']",
    "password = sys.argv[1]",
    'rules:{pass:"Element has sufficient color contrast",fail:"Element does not"}',
    'password: "Enter your Password here"',
    "Truth pass: clotr.app",
  ]);
});

test("a real password after the same labels still fires", () => {
  expectKinds([
    ["password: Summer2024!", "password"],
    ["password: Fluffy12", "password"],
    ["pw: Mx7!kq", "password"],
    ["password=hunter2", "password"],
    ["password: 739204", "password"],
    ["pin: 4821", "password"],
    ["pin = 482193", "password"],
    ["DB_PASSWORD=Tr0ub4dor3x", "password"],
    ["password_prod=Hunter22x", "password"],
    ["password_db: Hunter22x", "password"],
    ["PASSWORD_ADMIN=Sw0rdfish!", "password"],
    ["PASSWORD_ROOT=Sw0rdfish!", "password"],
    ["password_user: Sw0rdfish!", "password"],
    ["root_password: Sw0rdfish!", "password"],
    ["confirm_password: Sw0rdfish!", "password"],
    ["admin_password = 'Sw0rdfish!'", "password"],
    ['token = "' + body + '"', "password"],
    ["password: True2024", "password"],
    ["password: Bearer9!", "password"],
    ["password: !Summer2024", "password"],
    ["password: sunflower.blue", "password"],
    ["password: Password123", "password"],
    ["password: Hello(123)", "password"],
    ['password = "correct horse battery staple"', "password"],
    ["user: alex pass: Fluffy12", "password"],
    ["DB_PASS=Fluffy12", "password"],
    ["my password is Summer2024!", "password"],
    ["secret_key = '" + body + "'", "service_token"],
    ["api_key: " + body + "Zq3", "service_token"],
  ]);
});

// A token after an auth scheme word, unquoted ("token: Bearer …"), is the secret; the scheme word alone isn't.
test("a labelled token after Bearer or Basic is caught, and the token itself is what's covered", () => {
  const token = body + "Zq3";
  const basic = "YWRtaW46" + "S3AzdlQ5" + "eFEybQ==";
  const cases = [
    ["token: Bearer " + token, token],
    ["access_token: Bearer " + token, token],
    ["AUTH_TOKEN=Bearer " + token, token],
    ["api_key: Bearer " + token, token],
    ["secret: Bearer " + token, token],
    ["token: Basic " + basic, basic],
    ["Here is my config:\ntoken: Bearer " + token + "\n", token],
    ["token: bearer " + token + ", expires in an hour", token],
  ];
  const wrong = [];
  for (const [line, value] of cases) {
    const found = detect(line);
    const all = Object.values(found).flat();
    if (!all.includes(value) || all.some((m) => /^(?:bearer|basic)$/i.test(m))) {
      wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(found)}`);
    }
  }
  assert.deepEqual(wrong, [], "the token after the scheme word should be the match");
  expectQuiet([
    "token_type: Bearer",
    "token_type: Bearer\nexpires_in: 3600",
    "token: Bearer <your-token>",
    "token: Bearer ${ACCESS_TOKEN}",
    "auth_token: Bearer YOUR_TOKEN_HERE",
    "secret: Basic Authentication",
    "token: Bearer tokens are sent in the header",
  ]);
});

// Human passwords can look like code: dotted words, camelCase with "secret" in it, brackets.
test("a password that only looks like code still fires", () => {
  expectKinds([
    ["password: Correct.Horse.Battery", "password"],
    ["wifi password: Blue.Sky.Rain", "password"],
    ["PASSWORD=Summer.Autumn.Winter", "password"],
    ["password: Blue.Sky.Rain7", "password"],
    ["password: Correct.Horse.Battery.Staple9", "password"],
    ["password: superSecret", "password"],
    ["password: mySecret", "password"],
    ["wifi password: myPassword", "password"],
    ["password: TopSecret_Pass", "password"],
    ["password: purple_monkey_secret", "password"],
    ["API_KEY=my_secret_token", "password"],
    ["password: Fluffy(cat)9", "password"],
    // A word around a word is the shape of Field(alias), Some(pw) or Inject(Config), so it needs an INI file around
    // it, where a value is never code. A sentence can describe code, so it isn't enough.
    ["[home]\npassword: Fluffy(cat)", "password"],
    ["[home]\npassword: Kitty[Paw]", "password"],
    ["pin: 2024s", "password"],
  ]);
  // The same shapes in real code stay quiet.
  expectQuiet([
    "password: hashedPassword;",
    "const creds = { password: mySecret, user };",
    "login(user, password: mySecret)",
    "password = hashed_password",
    "password = hashedPassword",
    "token = accessToken",
    "password: passwordHash",
    "token = get_token()",
    "token = Token(user)",
    "password = crypt(pw)",
    "password = hash(pw, salt)",
    "secret = Secret.from_name('openai')",
    "token: ctx.request.token,",
    "password: this.form.password",
    "token_ttl: 30s",
    "SESSION_TOKEN_TIMEOUT=30m",
    'session_secret_env = "SESSION_SECRET"',
  ]);
  // A quoted value is a string, never code.
  expectKinds([
    ['"password": "superSecret"', "password"],
    ['password = "Correct.Horse.Battery"', "password"],
  ]);
});

// What a match covers, for checking the whole credential is in it.
function matchesOf(line) {
  return Object.values(detect(line)).flat();
}

// After a scheme word, the whole run is the credential whatever marks are in it or after it: a missed character
// must not turn the warning off.
test("a token after Bearer is caught whatever marks are in it or after it", () => {
  const token = "Xk29fQa7" + "LmP0zR3tVb8Nw";
  const cases = [
    "token: Bearer " + token + "!",
    "Here's my token: Bearer " + token + "?",
    "token: Bearer " + token + ":",
    "token: Bearer " + token + ".",
    "token: Bearer " + token.slice(0, 8) + "%2B" + token.slice(8),
    "token: Bearer " + token.slice(0, 8) + "$" + token.slice(8),
    "token: Bearer " + token.slice(0, 8) + "!" + token.slice(8),
    "token: Bearer " + token + "&next=1",
    "token: Bearer " + token + "#frag",
    "token: Bearer " + token + "@host",
    "token: Bearer " + token + "|next",
  ];
  const missed = [];
  for (const line of cases) {
    const all = matchesOf(line);
    const head = token.slice(0, 8);
    if (!all.some((m) => m.startsWith(head) && m.length >= token.length)) {
      missed.push(`${JSON.stringify(line)} → ${JSON.stringify(detect(line))}`);
    }
  }
  assert.deepEqual(missed, [], "the run after Bearer should be caught");
});

test("a key or token label with Bearer before its value is a service token too", () => {
  const token = "Xk29fQa7" + "LmP0zR3tVb8Nw";
  const missed = [];
  for (const line of [
    "stripe key: Bearer " + token,
    "service_key: Bearer " + token,
    "github key: Bearer " + token,
    "stripe key: bearer " + token + ".",
  ]) {
    const found = detect(line);
    if (!(found.service_token || []).includes(token)) missed.push(`${JSON.stringify(line)} → ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, [], "the token after Bearer should be the service token");
  expectQuiet(["stripe key: Bearer <your-key>", "service_key: Bearer ${SERVICE_KEY}", "auth key: Bearer tokens"]);
});

test("a Basic credential is caught when it decodes to a name and a password", () => {
  const basic = "dXNlcjpw" + "YXNz";
  const all = matchesOf("token: Basic " + basic);
  assert.ok(all.includes(basic), JSON.stringify(detect("token: Basic " + basic)));
  expectQuiet([
    "secret: Basic Authentication",
    "token: Basic auth",
    // The standard's own example, "Aladdin:open sesame".
    "token: Basic " + "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  ]);
});

// A comma, a bracket, "and" or a spaced " = " is ordinary writing too. Code needs more than that: a call or an
// object it sits in, a declaration at the start of the line, or an operator only code uses.
test("a password that looks like code fires in a sentence or a settings file", () => {
  expectKinds([
    ["password: superSecret, thanks!", "password"],
    ["Wi-Fi: HomeNet, password: superSecret, enjoy!", "password"],
    ["my wifi password: superSecret, and the guest one is open", "password"],
    ["password: superSecret and username: bob", "password"],
    ["password: superSecret or ask me", "password"],
    ["password: superSecret if you need it", "password"],
    ["(password: superSecret)", "password"],
    ["Login details (password: mySecret)", "password"],
    ["user: bob, password: mySecret, host: x", "password"],
    ["password: Fluffy(cat)9, thanks", "password"],
    ["[home]\npassword: Kitty[Paw], thanks", "password"],
    ["[home]\npassword: Kitty[Paw];", "password"],
    ["the final password: superSecret", "password"],
    ["Our public password: mySecret", "password"],
    ["[database]\npassword = superSecret\n", "password"],
    ["[wifi]\npassword = mySecret", "password"],
    ["PASSWORD = superSecret", "password"],
    ["WIFI_PASSWORD = mySecret", "password"],
    ["[wifi]\npassword = Kitty[Paw]", "password"],
    ["[wifi]\npassword = Fluffy(cat)", "password"],
    ["password: adminPassword", "password"],
    ["password: defaultPassword", "password"],
    ["password: tempPassword", "password"],
    ["password: newPassword", "password"],
    ["password: userPassword", "password"],
    ["password: dbPassword", "password"],
    // The same shape as the weak ones above, so it can't be told from one: a password is picked by hand.
    ["password: rootPassword", "password"],
    ["password: SUPER_SECRET", "password"],
    ["password: HUNTER_TWO", "password"],
    ['password: "MY_SECRET_PASS"', "password"],
  ]);
  // Code shapes stay quiet: a name holding the label's own word after a token, secret or key label, a call to a
  // function named for the secret or for hashing, and a member chain with a short part.
  expectQuiet([
    "token: githubToken",
    "token: npmToken",
    "secret: webhookSecret",
    "secret: cookieSecret",
    "secret: clientSecret",
    "api_key: openaiApiKey",
    "api_key: openai_api_key",
    "secret: Secret(name)",
    "password: Hash(pw)",
    "password: Crypt(pw)",
    "password: Decrypt(cfg)",
    "secret: vault.kv.read",
    "password: Settings.Db.Pw",
    "password = superSecret;",
    "const password = superSecret",
    "  private String password = mySecret",
    "password = pw or default_password",
    "password: DB_PASSWORD",
    "token: GITHUB_TOKEN",
    "PASSWORD = DEFAULT_PASSWORD",
    "password: Optional[str] = None",
    "password: CHANGE_ME",
    "password: TODO_FIXME",
    "password: Field(...)",
    "  user: dbUser,\n  password: userPassword,\n  host: dbHost,\n}",
    "const cfg = {\n  user: dbUser,\n  password: userPassword,\n};",
  ]);
});

test("a bracketed password is covered to its closing bracket", () => {
  const wrong = [];
  for (const [line, value] of [
    ["[home]\npassword = Hello(World)", "Hello(World)"],
    ["[home]\npassword = Kitty[Paw]", "Kitty[Paw]"],
    ["[home]\npassword = Pass[word]", "Pass[word]"],
    ["[home]\npassword: Pass[word].", "Pass[word]"],
    ["password: Fluffy(cat)9", "Fluffy(cat)9"],
  ]) {
    const all = matchesOf(line);
    if (!all.includes(value)) wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(detect(line))}`);
  }
  assert.deepEqual(wrong, [], "the match should run to the closing bracket");
});

// Python and TypeScript fields name a type or call a helper after the label; that's code, not a password.
test("a type annotation or a call after a secret's label stays quiet", () => {
  expectQuiet([
    "password: Optional[str]",
    "token: Optional[str]",
    "api_key: Optional[str]",
    "password: List[str]",
    "secret: Dict[str, str]",
    "password: Union[str, None]",
    "password: Annotated[str, Form()]",
    "secret: Optional[SecretStr]",
    "    token: str\n    password: Optional[str]\n",
    "password: Optional[Password]",
    "token: Some(Token)",
    "password: Field(alias)",
    "password: Field(default)",
    "password: Settings[key]",
    "secret: Secrets(name)",
    "token: Tokens(user)",
    "password: Prompt(msg)",
    "password: Input(prompt)",
    "password: Getpass(prompt)",
    "password: Vault(path)",
    "secret: Fetch(name)",
    "password: Config(key)",
    "password: Lookup(name)",
    "password: Pbkdf2(pw)",
    "token: Ref(x)",
    "password: Some(pw)",
    "password: Box(pw)",
    "password: String(pw)",
    "password: Buffer(pw)",
    "password: Bytes(pw)",
    "password: Read(pw)",
    "password: Load(pw)",
    "secret: Secret(name).value",
    "password: get(pw)[0]",
    "password: App.Settings.Value",
    "password: DB_PASS",
    "password: SECRET_KEY",
    "password: ADMIN_PASS",
    "password: CLIENT_SECRET",
    "token = DEFAULT_VALUE",
    "secret = EMPTY_STRING",
    "private password: String",
    "  public token: Optional[str]",
    "readonly token: Token",
    "static password: SecretStr",
    "password: Field(Alias)",
    "password: Inject(Config)",
    "token: Depends(Auth)",
    "password: Depends(get_password)",
    "password: Field(..., min_length=8)",
    "password: Secret[str]",
    "password: Query(None)",
    "token: Cookie(alias)",
    "password: Fluffy(cat)",
    "secret: Config.Db.Url",
    "password: System.Text.Encoding",
    "password: superSecret,\n",
    "password: Optional[Token]",
    "password: Type[Password]",
    "token: Annotated[str, Header()]",
    "password: Mapped[str]",
    "password: Column(String)",
    "password: Column(Text)",
    "token: Header(None)",
    "password: Depends(Login)",
    "password: Fernet(key)",
    "secret: Secret(Name)",
    "[auth]\npassword = Optional[str]",
    "password: Field(alias) or None",
    "    password: str\n    token: Optional[str] = None\n",
    "class User(BaseModel):\n    password: Optional[str]\n    token: SecretStr\n",
    "interface Creds {\n  password: string;\n  token: Token;\n}",
    "type Login = {\n  password: Password,\n  token: Token,\n}",
    "final password: String",
    "private password: Secret",
    "public token: AccessToken",
    "let password: string | undefined",
    "password: superSecret,\n  token: accessToken,\n}",
    "login({\n  password: superSecret,\n  remember: true,\n})",
    "password = superSecret;  // set",
    "password = DEFAULT_PASS",
    "password = ADMIN_PASSWORD",
    "token = SESSION_TOKEN",
    "secret = API_SECRET",
    "PASSWORD = ENV_PASSWORD",
    "password = MY_VALUE",
    "password: os.path.join",
    "password: io.read.all",
    "password: my.config.pw",
    "password: user.pw.hash",
    "password: currentUser.password",
    "password: resetPasswordToken",
    "password: sessionPasswordHash",
    "token: Bearer",
    "token: Bearer tokens",
    "token: JWT",
    "token: Bot",
    "secret: Opaque\ndata:\n  username: x",
    "token: Digest realm",
    "token_type: Token",
    "auth_scheme: Basic",
    "token: Basic auth\nuser: bob",
    "token: Basic YWJj",
    // A sentence describing code is still code.
    "Set the password: Input(prompt)",
    "your password: Field(alias)",
    "password: Field(alias), see docs",
    "password: Fluffy(cat) and username: bob",
    "my password: Some(pw)",
    "x = 1;\npassword = superSecret ; y = 2",
    "let password: superSecret;",
    "export password: superSecret",
    "  password: superSecret;",
  ]);
});

test("a token after any scheme word, or after punctuation or a line break, is caught and covered", () => {
  const token = "Xk29fQa7" + "LmP0zR3tVb8Nw";
  const letters = "XkfQaLmP" + "zRtVbNw";
  const basic = "dXNlcjpw" + "YXNzMQ";
  const cases = [
    ["token: Bearer: " + token, token],
    ["API key: Bearer: " + token, token],
    ["token: Bearer, " + token, token],
    ["token: Bearer - " + token, token],
    ["token: Bearer\n" + token, token],
    ["api key: Bearer\n" + token, token],
    ["token: OAuth " + token, token],
    ["token: OAuth2 " + token, token],
    ["token: Digest " + token, token],
    ["token: JWT " + token, token],
    ["token: Opaque " + token, token],
    ["token: Bot " + token, token],
    ["token: Token " + token, token],
    ["stripe key: Token " + token, token],
    ["stripe key: 'Bearer " + token + "'", token],
    ["token: Bearer " + letters, letters],
    ["token: Basic " + basic, basic],
  ];
  const wrong = [];
  for (const [line, value] of cases) {
    const all = matchesOf(line);
    if (!all.includes(value) || all.some((m) => /^(?:bearer|basic|token|bot|oauth2?|digest|jwt|opaque)$/i.test(m))) {
      wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(detect(line))}`);
    }
  }
  assert.deepEqual(wrong, [], "the credential after the scheme word should be the match");
  expectQuiet([
    "token_type: Bearer\nexpires_in: 3600",
    "token: Bearer:",
    "token: Bearer\n\nthanks",
    "token: Token expired",
    "token: Bot tokens are listed in the portal",
    "secret_type: Opaque",
    "token: OAuth flow",
    "stripe key: Token <your-key>",
    "token: Bearer\nexpires_in: 3600",
  ]);
});

test("a token after a scheme word in quotes, brackets or after other marks is caught without its marks", () => {
  const token = "Xk29fQa7" + "LmP0zR3tVb8Nw";
  const cases = [
    ["token: Bearer `" + token + "`", token],
    ["token: Bearer; " + token, token],
    ["token: Bearer = " + token, token],
    ["token: Bearer => " + token, token],
    ["token: Bearer -> " + token, token],
    ["token: (Bearer " + token + ")", token],
    ["token: [Bearer " + token + "]", token],
    ['token: "Bearer" ' + token, token],
    // Only the standard's own example is quiet, not every Aladdin.
    ["token: Basic " + "YWxhZGRpbjpvcGVuc2VzYW1l", "YWxhZGRpbjpvcGVuc2VzYW1l"],
  ];
  const wrong = [];
  for (const [line, value] of cases) {
    const all = matchesOf(line);
    if (!all.includes(value)) wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(detect(line))}`);
  }
  assert.deepEqual(wrong, [], "the credential alone should be the match");
  expectQuiet([
    "token: (Bearer tokens)",
    'token_type: "Bearer" expires_in',
    "token: Bearer = required",
    'token: "Bearer" expires_in3600',
    "token: [Bearer]",
    "token: Basic " + "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  ]);
});

test("a password told in a sentence, a letter or an INI file fires even when it looks like code", () => {
  expectKinds([
    ["final password: superSecret", "password"],
    ["public password: mySecret", "password"],
    ["private password: superSecret", "password"],
    ["password: superSecret,\nthanks", "password"],
    ["Hi Bob,\nwifi password: superSecret,\nsee you", "password"],
    ["[db]\npassword = superSecret ; set by admin", "password"],
    ["[db]\npassword = HUNTER_TWO", "password"],
    ["password=HUNTER_TWO", "password"],
    ["WIFI_PASSWORD=SUPER_SECRET", "password"],
    ["PASSWORD = SUPER_SECRET", "password"],
    ["password: I.love.my.dog", "password"],
    ["password: go.team.go", "password"],
    ["password: me.and.you", "password"],
    ["password: oldPassword", "password"],
    ["password: currentPassword", "password"],
    ["password: resetPassword", "password"],
    ["password: authPassword", "password"],
    ["password: sessionPassword", "password"],
    ["[wifi]\npassword = Hello(World)", "password"],
  ]);
  // The code these were told apart from stays quiet.
  expectQuiet([
    "  password: userPassword,\n  host: dbHost,",
    "  password: userPassword,\n  // the host\n",
    "password = superSecret;",
    "password = superSecret ;\n",
    "const password: superSecret = x",
    "password: sessionToken",
    "token: sessionToken",
    "secret: os.environ.get",
    "password: req.body.pw",
    "const cfg = { password: oldPassword };",
  ]);
});

// A constant in capitals after a password label is an enum, a setting or a placeholder far more often than a
// password, so only the shapes a person types fire: a stressed "secret" (SUPER_SECRET) or a word and a number word
// (HUNTER_TWO).
test("a placeholder, enum or constant in capitals after a password or token label stays quiet", () => {
  expectQuiet([
    "password=SET_ME",
    "password=TO_BE_SET",
    "password=LEAVE_BLANK",
    "password=SEE_BELOW",
    "password=NOT_SET",
    "PASSWORD=NOT_REQUIRED",
    "token=NOT_NEEDED",
    "password=AUTO_GENERATED",
    "password=AUTO_DETECT",
    "PASSWORD=USE_SSO",
    "password=USE_KEYRING",
    "PASSWORD=FROM_KEYCHAIN",
    "PASSWORD=ON_DEMAND",
    "password=LOGIN_FORM",
    "password=MYSQL_ROOT",
    "password=SOME_CONSTANT",
    "PASSWORD_STORAGE=PLAIN_TEXT",
    "REDIS_PASSWORD=NOT_SET",
    "SMTP_PASSWORD=NOT_REQUIRED\nSMTP_USER=bob",
    "[db]\npassword = SOME_CONSTANT",
    "    password = SOME_CONSTANT",
    "password: SET_ME",
    "password: NOT_SET",
    "password: NONE_GIVEN",
    "password: LEAVE_BLANK",
    "password: SOME_CONSTANT",
    "password: MYSQL_ROOT",
    "password: PHASE_TWO",
    "password: LEVEL_ONE",
    'password: "SET_ME"',
    '"password": "NOT_SET"',
    "password: 'SOME_CONSTANT'",
    'token: "NOT_NEEDED"',
    'token: "MY_API_KEY"',
    'password = "LEAVE_BLANK"',
    "password=GENERATE_ONE",
    "password=PICK_ONE",
    "password: CHOOSE_ONE",
    "password: ANY_ONE",
    "password=USE_ONE",
    "password: PICK_TWO",
    "password: OPTION_TWO",
    "token=PHASE_ONE",
    'password: "MY_SECRET"',
    "password: MY_SECRET_PASS",
  ]);
  expectKinds([
    ["password=HUNTER_TWO", "password"],
    ["WIFI_PASSWORD=SUPER_SECRET", "password"],
    ["password: HUNTER_TWO", "password"],
    ["password: SUPER_SECRET", "password"],
    ["[db]\npassword = HUNTER_TWO", "password"],
    ["password: TOP_SECRET", "password"],
    ['password: "SUPER_SECRET"', "password"],
    ['password: "HUNTER_TWO"', "password"],
    ['password: "MY_SECRET_PASS"', "password"],
  ]);
});

// A name like newPassword or dbPassword is a variable in code and a weak password in a note alike. Any sign of code
// around it (a closing bracket, a semicolon, a comment, a quoted key, an "=" setting, an indented member) makes it the
// variable; only a bare "password: myPassword" line reads as a password.
test("a password variable's name after a password label in code or settings stays quiet", () => {
  expectQuiet([
    "  password: newPassword });",
    "  password: newPassword }",
    "password: newPassword)",
    "password: newPassword;",
    "password: newPassword // from form",
    "password: newPassword # from form",
    '"password": newPassword',
    "'password': newPassword",
    "password = newPassword",
    "password=newPassword",
    "  password: newPassword\n\n}",
    "  email: email,\n  password: newPassword\n  // trailing\n}",
    "  password: tmpPassword,\n  email\n",
    "DB_PASSWORD=dbPassword",
    "PASSWORD=adminPassword",
    "mysql -u root --password=dbPassword",
    "$ curl -d password=newPassword",
    "data:\n  password: dbPassword\n",
    "password: userPassword)",
    "password: dbPassword;",
    "password: adminPassword }",
    "password: tempPassword // temp",
    "password: myPassword);",
    '"password": userPassword,',
    "password = adminPassword",
    "PASSWORD=tempPassword",
    "password=myPassword",
    "  password: userPassword\n",
    "login(\n  password: newPassword\n)",
    "password: newPassword\n}",
    "password: newPassword\n  // note\n}",
    "password:newPassword",
    "password: my_password",
    "password: pass_word",
    "password: My_Password",
    "password: db_password;",
    // A variable without the label's word in the same code shapes.
    "password: superSecret;",
    "password: superSecret }",
    '"password": superSecret',
    "'password': mySecret,",
    "password: mySecret // from env",
    "password: superSecret\n\n}",
  ]);
  expectKinds([
    ["wifi password: myPassword", "password"],
    ["password: adminPassword", "password"],
    ["password: dbPassword", "password"],
    ["password: newPassword", "password"],
    ["password: userPassword", "password"],
    ["password: rootPassword", "password"],
    ["my wifi password: myPassword thanks", "password"],
    ["password: myPassword.", "password"],
    ["Hi Bob,\nwifi password: myPassword\nsee you", "password"],
    // A different word from the label's still reads as a password when set with "=".
    ["WIFI_PASSWORD = mySecret", "password"],
    ["PASSWORD = superSecret", "password"],
  ]);
});

// A parameter after a scheme word ("Bearer, expires_in=3600") or a protocol's version isn't the credential.
test("a parameter or a protocol after a scheme word stays quiet, and a token after it still fires", () => {
  expectQuiet([
    "token: Bearer, expires_in=3600",
    "token: Bearer; expires_in=3600",
    "access_token: Bearer, expires_in=3600",
    "token: Bearer, version=2",
    "token: Bearer; charset=UTF-8",
    "token: Basic; charset=UTF-8",
    "token: Bearer; ttl=3600",
    "token: Bearer; max_age=3600",
    "token: Bearer; expires=3600",
    "token: Bearer, expires=1h",
    "token: Bearer, kid=abc123",
    "token: Bearer, alg=HS256",
    "token: Bearer, nonce=n0nce42",
    "token: Bearer; HTTP/1.1",
    "token: Bearer expires_in=3600",
    "token: Bearer, expires_in:3600",
    "token: Bearer, nonce:n0nce42",
    'token: Digest realm="api2"',
    "stripe key: Bearer, expires_in=3600",
    "token: Basic " + "dXNlcm5hbWU6cGFzc3dvcmQ=",
  ]);
  const token = "Xk9vQ2mL" + "pR7tW3zY8nB4cF6h";
  expectKinds([
    ["token: Bearer " + token, "password"],
    ["token: Bearer " + token + "&next=1", "password"],
    ["token: Bearer abc123==", "password"],
    ["token: Basic " + "Ym9iOmh1bnRlcjI=", "password"],
  ]);
  const oauth = detect('token: OAuth oauth_consumer_key="' + token + '"');
  assert.equal(oauth.password, undefined, JSON.stringify(oauth));
});

// More of an object or a call after a password variable's name, on its line or on indented lines down to the
// closing bracket, is code too.
test("a password variable's name with more of an object or a call after it stays quiet", () => {
  expectQuiet([
    "password: newPassword, email })",
    "password: newPassword, email }",
    "password: newPassword, ...rest })",
    "password: newPassword, ...rest",
    "password: newPassword, remember: true",
    "password: newPassword, email: email",
    "password: newPassword, // from form",
    "password: newPassword, /* from form */",
    "password: newPassword, # from form",
    "password: newPassword as string",
    "password: newPassword as string,",
    "password: newPassword satisfies string",
    "password: newPassword + salt",
    "password: newPassword ? hash(newPassword) : null",
    "password: superSecret, email })",
    "password: superSecret as string",
    "password: superSecret, // from form",
    "password: newPassword\n  email: email\n}",
    "password: newPassword\n    email: email,\n  });",
    "password: newPassword\n  remember: true\n})",
    "password: dbPassword\n  host: dbHost\n}",
    "password: newPassword\n  ,email\n}",
    "password: superSecret\n  email: email\n}",
  ]);
  expectKinds([
    ["password: dbPassword", "password"],
    ["wifi password: myPassword", "password"],
    ["(password: superSecret)", "password"],
    ["password: superSecret, thanks", "password"],
    ["password: superSecret, thanks!", "password"],
    ["Wi-Fi: HomeNet, password: superSecret, enjoy!", "password"],
    ["password: superSecret and username: bob", "password"],
    ["password: superSecret,\nthanks", "password"],
    ["Hi Bob,\nwifi password: superSecret,\nsee you", "password"],
  ]);
});

// A variable's name after a secret's label reads as a password only on a bare line: nothing after it on its line is
// a code character, and the next line isn't indented or a closing bracket. Every code shape is quiet at once,
// whatever the label.
test("a variable's name after any secret label stays quiet in every code shape and fires on a bare line", () => {
  const shapes = [
    ", email\n})",
    ", email\n  })",
    ", email\n}\n",
    ", email: user.email\n});",
    ", username: user })",
    ', callbackUrl: "/" })',
    ", callbackUrl: '/'",
    ", 'x')",
    ", 10)",
    ", 10, true)",
    ", { expiresIn: 3600 })",
    ", () => {})",
    ", function () {})",
    " === confirm",
    " === confirmPassword ? ok : fail",
    " !== ''",
    " == null",
    " + '!'",
    " && x",
    " || ''",
    "\n  ...rest\n}",
    ", email: req.body.email",
    ", email: values.email",
    ", email: emailInput",
    ", email: String(email)",
    ", confirm: confirmPassword",
    ", 'remember': true",
    ", remember: !!remember",
    ", email, remember })",
    ", email\n\n})",
  ];
  const pairs = [
    ["password", "newPassword"],
    ["password", "dbPassword"],
    ["password", "superSecret"],
    ["password", "userPassword"],
    ["password", "myPassword"],
    ["password", "adminPassword"],
    ["password", "tempPassword"],
    ["password", "plainPassword"],
    ["PASSWORD", "newPassword"],
    ["Password", "superSecret"],
    ["pwd", "newPwd"],
    ["pass", "userPass"],
    ["passphrase", "myPassphrase"],
    ["passcode", "newPasscode"],
    ["pin", "newPin"],
    ["wifi password", "myPassword"],
    ["token", "newPassword"],
    ["token", "superSecret"],
    ["secret", "myPassword"],
    ["api_key", "userPassword"],
  ];
  const quiet = [];
  for (const [label, name] of pairs) for (const shape of shapes) quiet.push(`${label}: ${name}${shape}`);
  expectQuiet(quiet);
  expectKinds([
    ["password: dbPassword", "password"],
    ["wifi password: myPassword", "password"],
    ["(password: superSecret)", "password"],
    ["password: superSecret, thanks", "password"],
    ["user: bob, password: mySecret, host: x", "password"],
    ["pwd: newPwd", "password"],
    ["pin: newPin", "password"],
    ["token: superSecret", "password"],
    ["secret: myPassword", "password"],
    ["API_KEY=my_secret_token", "password"],
    ["[db]\npassword = superSecret ; set by admin", "password"],
  ]);
});

// A Bearer token and Basic's base64 never hold a ":", so a name and a value after the scheme word is a parameter.
test("a name:value parameter after a scheme word stays quiet", () => {
  expectQuiet([
    "token: Bearer, client_id:app42",
    "token: Bearer, jti:a1b2c3",
    "token: Bearer; client_id:app42",
    "token: Bearer; jti:a1b2c3",
    "token: Bearer jti:a1b2c3",
    "token: Bearer: jti:a1b2c3",
    "token: Bearer - jti:a1b2c3",
    "token: Bearer, client_id: app42",
    "token: Bearer, scope:read",
    "token: Basic, client_id:app42",
    "stripe key: Bearer, client_id:app42",
  ]);
  const token = "Xk9vQ2mL" + "pR7tW3zY8nB4cF6h";
  expectKinds([
    ["token: Bearer, " + token, "password"],
    ["token: Bearer " + token + ":", "password"],
  ]);
});

test("a test or account constant, or a classification, in capitals stays quiet", () => {
  expectQuiet([
    "password=DEMO_TWO",
    "password=MOCK_TWO",
    "password=FIXTURE_TWO",
    "password=ADMIN_TWO",
    "password=WPA_TWO",
    "token: OAUTH_TWO",
    "TOKEN_CLASSIFICATION=TOP_SECRET",
    "PASSWORD_LEVEL=TOP_SECRET",
    "token_scope=TOP_SECRET",
  ]);
  expectKinds([
    ["password=HUNTER_TWO", "password"],
    ["password: TOP_SECRET", "password"],
    ["PASSWORD_LEVEL=hunter2", "password"],
  ]);
});

test("a key or token label naming a lookup, page, message or file is not a service token", () => {
  expectQuiet([
    "Redis key: user:12345:session:v2",
    "translation key: home.hero.title_2024",
    "i18n_key = 'checkout.summary.total_v2'",
    "registry key: HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor2\\App",
    "hash key: user#2024-03-14#A1",
    "s3 key: uploads/2024/03/a1b2c3d4.png",
    "React key: item-9f8e7d6c5b4a",
    "storage key: user_settings_v3_2024",
    "message key: ERR_TOKEN_EXPIRED_401",
    "env key: NEXT_PUBLIC_API_URL2",
    "feature flag key: new-checkout-flow-2024Q1",
    "next token: 7f3a9c2e-1b4d-4e8a-9f0c-2d6b8a1e3c57",
    "CSRF token: Xy7pQ2rT9vB4nM8kL3wZ6cF1",
    "page_token=AHWqTUlx3Q7nY2bS8kZr1vD4",
    "continuation_token: 1ZkL9pQ3rT7vB2nM8xW4cY6",
    "next_page_token: AHWqTUlx3Q7nY2bS8kZr1vD4",
  ]);
  expectKinds([
    ["service key: " + body + "Zq3", "service_token"],
    ["license key: 7Q2K9-PL4XM-88RTW-B3NVZ", "service_token"],
    ["access key: " + body + "Zq3", "service_token"],
    ["Heroku API key: 7f3a9c2e-1b4d-4e8a-9f0c-2d6b8a1e3c57", "service_token"],
    ["s3 key: " + cloudKey, "service_token"],
    ["storage key: " + cloudKey + "Ab1/Cd2+", "service_token"],
    ["STORAGE_KEY=" + cloudKey, "service_token"],
    ["refresh token: " + body + "Zq3", "service_token"],
  ]);
});

test("git dates, versions, log counters and machine constants are not phone numbers", () => {
  expectQuiet([
    "commit 9f2c4e1a7b3d5f6e8a0c2b4d6f8e0a1c3b5d7f9e\nAuthor: Jane Dev\nDate:   Mon Oct 21 21:24:38 2026 +0000\n\n    Fix parser",
    "Date:   Tue Oct 6 09:15:02 2026 -0700",
    "AuthorDate: Mon Oct 21 21:24:38 2026 +0000\nCommitDate: Mon Oct 21 21:30:11 2026 +0530",
    "Chrome/131.0.6778.205 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.6421.112 Safari/537.36",
    "[12345.678901] eth0: link up, 1000Mbps, full-duplex",
    "[ 4815.162342] usb 1-1: new high-speed USB device",
    "Process exited after 4815162342 ns",
    "took 4815162342 ns",
    "INT_MAX is 2147483647",
    "maxInt = 2147483647",
    "UINT_MAX 4294967295",
    "values = [4815162342, 2718281828, 3141592653]",
    "card 5452 74......0708 was declined",
    "Date:   Mon Jan 1 00:00:00 2020 +0000",
    "values = [0050023932, 0192092317, 0739643308]",
    "uploads/fixture-0044/264107a3.png",
    "uploads/fixture-0125/337909e6.png",
    "25/02/2026 11:52",
    "deployed 20.05.2026 17:01 by ops",
    'GET /api/v1/items/16237?page=11 HTTP/1.1" 200 2537 "-" "Mozilla/5.0"',
    '203.0.113.5 - - [27/Oct/2026:13:28:53 +0000] "POST /login HTTP/2" 302 5796 "-"',
    "commit 9f2c4e1a7b3d5f6e8a0c2b4d6f8e0a1c3b5d7f9e\nMerge: 7e07413 9341826\nAuthor: Jane Dev",
  ]);
});

test("a real phone number still fires next to the same machine text", () => {
  expectKinds([
    ["Call me at 415-829-3746 tomorrow", "phone_number"],
    ["my number is (415) 829-3746", "phone_number"],
    ["phone: +44 7911 123456", "phone_number"],
    ["text me on 07911 123456", "phone_number"],
    ["reach me at 415.829.3746", "phone_number"],
    ["Mon Oct 21, call 415 829 3746", "phone_number"],
    ["4158293746", "phone_number"],
    ["Date:   Mon Oct 21 21:24:38 2026 +0000\n\n    Call Jane at 415-829-3746", "phone_number"],
    ["call 4158293746 after 5", "phone_number"],
    ["numbers: [415-829-3746, 212-555-7834]", "phone_number"],
    ['"phones": [4158293746, 2125557834]', "phone_number"],
    ["my cell is (214) 748-3647", "phone_number"],
    ["ring me on 0044 20 7946 0958", "phone_number"],
    ["call 01253 379094", "phone_number"],
    ["25/02/2026 11:52 call 415 829 3746", "phone_number"],
    ['GET /callback?phone=4158293746 HTTP/1.1" 200 2537', "phone_number"],
    ["Merge: 7e07413 9341826\n\n    Ask Jane on 415 829 3746", "phone_number"],
  ]);
});

test("version and firmware numbers are not internal IP addresses", () => {
  expectQuiet([
    "Firmware 10.5.14.31",
    "Firmware 10.5.14.31 build 48213",
    "upgrade from 10.2.3.4",
    "Version: 10.2.1.4",
    "version 10.4.0.12 released",
    "v10.1.2.3",
    "Microsoft Windows [Version 10.0.19045.4651]",
    "Bumped chalk from 10.2.3.4 to 10.2.3.5",
  ]);
  expectKinds([
    ["ssh admin@10.2.3.4", "internal_ip"],
    ["server at 10.2.3.4", "internal_ip"],
    ["DB_HOST=10.20.30.40", "internal_ip"],
    ["the new version is up on 10.2.3.4", "internal_ip"],
    ["curl http://10.2.3.4:8080/version", "internal_ip"],
    ["build server at 10.2.3.4", "internal_ip"],
    ["connection from 10.2.3.4 refused", "internal_ip"],
    ["Firmware 10.5.14.31 on gateway 10.2.3.4", "internal_ip"],
  ]);
});

test("AWS account IDs and product codes are not bank accounts or SSNs", () => {
  expectQuiet([
    "arn:aws:lambda:us-east-1:482019375564:function:api-handler (account 482019375564)",
    "AWS account 482019375564",
    "account: 482019375564 region: us-east-1",
    "SKU 460-12-3447 qty 39",
    "Part no. 460-12-3447, rev B",
    "item 512-44-8723 restocked",
  ]);
  expectKinds([
    ["bank account 482019375564", "bank_account"],
    ["account number: 482019375564", "bank_account"],
    ["My SSN is 512-44-8723", "us_ssn"],
    ["ssn 512-44-8723", "us_ssn"],
    ["512-44-8723", "us_ssn"],
    ["SKU 460-12-3447 for ssn 512-44-8723", "us_ssn"],
    ["the AWS bill is paid from bank account 482019375564", "bank_account"],
    ["checking account 482019375564 in us-east-1", "bank_account"],
  ]);
});

// A bare Canadian SIN is reported as a US SSN for now: the national ID rule only takes one after a SIN label,
// so dropping it here would leave it unflagged. It must keep firing as something.
test("a SIN-shaped number keeps firing, and SSN labels still win", () => {
  const silent = [];
  for (const line of ["046 454 286", "046-454-286", "130 692 544", "SIN 046 454 286"]) {
    if (!Object.keys(detect(line)).length) silent.push(line);
  }
  assert.deepEqual(silent, [], "these should not be silent");
  expectKinds([
    ["SIN 046 454 286", "national_id"],
    ["ssn 046 454 286", "us_ssn"],
    ["social security number: 046-454-286", "us_ssn"],
    ["512 448 723", "us_ssn"],
    ["512448723", "us_ssn"],
    ["512-44-8723", "us_ssn"],
  ]);
});

test("code namespaces, member access and container names are not internal hostnames", () => {
  expectQuiet([
    "import kotlinx.coroutines.internal",
    "at com.acme.billing.internal.Invoice.run(Invoice.java:42)",
    "using Microsoft.AspNetCore.Internal;",
    "from .settings.local import *",
    "cp settings.local settings.py",
    "DB_HOST=host.docker.internal",
    "redis.default.svc.cluster.local",
    "if(spec.local)return t.internal",
    "node.local = true",
    "this.internal = {}",
  ]);
  expectKinds([
    ["DB_HOST=db01.corp.internal", "internal_host"],
    ["ssh build-01.local", "internal_host"],
    ["printer at printer3.office.local", "internal_host"],
    ["jira.acme.corp is down", "internal_host"],
    ["connect to api.internal", "internal_host"],
    ["export DB_HOST=db01.corp.internal", "internal_host"],
    ["ping node.local", "internal_host"],
    ["DC01.CORP.local", "internal_host"],
  ]);
});

test("a git SSH remote is not an email address", () => {
  expectQuiet([
    "git clone git@github.com:acme/app.git",
    "origin  git@gitlab.com:acme/app.git (fetch)\norigin  git@gitlab.com:acme/app.git (push)",
    "remote: git@bitbucket.org:team/repo.git",
  ]);
  expectKinds([
    ["email me at jane@acme-mail.com", "email"],
    ["git@acme-mail.com wrote:", "email"],
    ["contact: git@acme-mail.com: see above", "email"],
  ]);
});

test("a Slack token needs a random tail", () => {
  expectQuiet(["SLACK_BOT_TOKEN=xox" + "b-not-a-real-token", "xox" + "p-1234-5678-abcd"]);
  expectKinds([
    ["SLACK_BOT_TOKEN=xoxb-" + "736158204937-4829105736284-" + "aB3dE5fG7hJ9" + "kL1mN3pQ5rS7", "slack_token"],
    ["xoxp-" + "736158204937-4829105736284-7361582049375-" + "9f2c4e1a7b3d5f6e" + "8a0c2b4d6f8e0a1c", "slack_token"],
    ["xoxb-" + "736158204937-4829105736284-" + "aBcdEfGhJkLmNpQrStUvWxYz", "slack_token"],
  ]);
});
