// A secret under a name that ends in a role word: Value, Ref, Reference or Arn, written camelCase, PascalCase, with
// a dot or an underscore. The value is found whole, and a plain value under such a name stays as it was.
// Every value here is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

const Clotr = globalThis.Clotr;

// A made-up key, in two parts so this line isn't key-shaped to a secret scanner.
const KEY = "Zq7fAkE9mAdE4" + "uP2xK8vN3tR6wB1";
const PW = "Maple7!river";
const PHRASE = "copper-meadow-falcon";

// Each password and service_token finding as "kind=[matches]", or "quiet".
function read(text) {
  return (
    Clotr.detect(text)
      .filter((f) => f.id === "password" || f.id === "service_token")
      .map((f) => `${f.id}=${JSON.stringify(f.matches)}`)
      .join(" ") || "quiet"
  );
}

// The matches of every password and service_token finding, in one list.
function matches(text) {
  return Clotr.detect(text)
    .filter((f) => f.id === "password" || f.id === "service_token")
    .flatMap((f) => f.matches);
}

test("a secret under a name ending in Value, Ref, Reference or Arn is found whole", () => {
  const rows = [
    [`<SecretValue>${PW}</SecretValue>`, PW],
    [`<passwordValue>${PW}</passwordValue>`, PW],
    [`apiKeyRef: ${KEY}`, KEY],
    [`const apiKeyRef = '${KEY}';`, KEY],
    [`stripe_key_ref: ${KEY}`, KEY],
    [`<PasswordRef>${PW}</PasswordRef>`, PW],
    [`<passwordReference>${PW}</passwordReference>`, PW],
    [`<secretArn>${KEY}</secretArn>`, KEY],
    [`db.password.value=${PHRASE}`, PHRASE],
    [`db.password.ref=${PW}`, PW],
    [`app.secret.arn=${KEY}`, KEY],
  ];
  for (const [text, value] of rows) {
    const found = matches(text);
    assert.ok(found.length > 0, `not found: ${text}`);
    for (const m of found) assert.equal(m, value, `found more or less than the value: ${text}`);
    const covered = Clotr.redact(text, Clotr.detect(text));
    assert.ok(
      !covered.includes(value.slice(0, 6)) && !covered.includes(value.slice(-6)),
      `Cover it left part: ${text}`,
    );
  }
});

test("a plain value of joined words under a role-word name stays as it was", () => {
  for (const text of [
    "apiKeyRef: stripe-live-key",
    `<password_ref>${PHRASE}</password_ref>`,
    `<db-password-ref>${PHRASE}</db-password-ref>`,
    `<passwordRef>${PHRASE}</passwordRef>`,
    `<secretValue>${PHRASE}</secretValue>`,
    `stripe_key_ref: ${PHRASE}`,
  ]) {
    assert.equal(read(text), "quiet", text);
  }
});

test("a role-word name holding a pointer, code or nothing stays as it was", () => {
  const rows = [
    ["const passwordRef = useRef(null);", "quiet"],
    ["const passwordRef = useRef<HTMLInputElement>(null);", "quiet"],
    ['<input type="password" ref={passwordRef} />', "quiet"],
    ["passwordRef.current.focus();", "quiet"],
    ["const tokenRef = React.createRef();", "quiet"],
    // Live and the trunk flag the ARN's last part; a later round takes that false alarm.
    ["secretArn: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf", 'password=["prod/db-AbCdEf"]'],
    ["const passwordValue = event.target.value;", "quiet"],
    ["passwordValue: string;", "quiet"],
    ["apiKeyRef: process.env.API_KEY_REF,", "quiet"],
    ["tokenValue = getToken()", "quiet"],
    ["secretValue: ${SECRET_VALUE}", "quiet"],
    ["secretKeyRef:\n  name: db-credentials\n  key: password", "quiet"],
    ["passwordRef: passwordInput,", "quiet"],
    ["secretKeyRef: db-credentials", "quiet"],
    ["<passwordRef>prod-db-login</passwordRef>", "quiet"],
    ["tokenValue: undefined,", "quiet"],
    ['const secretValue = "";', "quiet"],
    ["keyRef: mainKey", "quiet"],
    ["secretArn: !GetAtt DbSecret.Arn", "quiet"],
    [
      "<secretArn>arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf</secretArn>",
      'password=["prod/db-AbCdEf</secretArn>"]',
    ],
    // The "secret:" label inside the ARN still reads what follows it, as on live.
    ["app.secret.arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:prod-AbCdEf", 'password=["prod-AbCdEf"]'],
    ["db.password.ref=prod-db-password", "quiet"],
    ["spring.datasource.password.value=${DB_PASSWORD}", "quiet"],
    ["apiKeyRef: vault/prod/db", "quiet"],
    ["<passwordRef>vault/prod/db</passwordRef>", "quiet"],
    [
      "<secretArn>arn:aws:secretsmanager:us-east-1:123456789012:secret:prod</secretArn>",
      'password=["prod</secretArn>"]',
    ],
  ];
  for (const [text, want] of rows) assert.equal(read(text), want, text);
});

test("joined words under a dotted ref, reference or arn name stay quiet, as under <password_ref>", () => {
  for (const text of [`db.password.ref=${PHRASE}`, `app.secret.reference=${PHRASE}`, `app.secret.arn=${PHRASE}`]) {
    assert.equal(read(text), "quiet", text);
  }
});

test("the name of a database, service or vault under a dotted ref or arn name stays quiet", () => {
  const values = [
    "prod-db-login",
    "orders-db",
    "main-database",
    "payments-service",
    "postgres-main",
    "stripe-api",
    "github-app",
    "keyvault.prod",
    "user-service.db",
  ];
  const names = ["db.password.ref", "app.secret.ref", "app.secret.arn", "app.token.ref"];
  const texts = values.flatMap((v) => names.map((n) => `${n}=${v}`));
  texts.push(
    "spring.datasource.password.ref=main-database",
    "db.password.ref=mysql_prod",
    "db.password.ref=keyvault-prod-eastus",
    "spring.datasource.password.ref=datasource-credentials",
  );
  assert.deepEqual(
    texts.filter((text) => read(text) !== "quiet"),
    [],
  );
});

test("a capitalised name with a number under a ref or arn name stays quiet", () => {
  const values = [
    "StripeLiveKey2024",
    "KeyVaultSecret01",
    "OrdersDb2024",
    "PaymentsService1",
    "DbPassword2024",
    "GithubToken2",
  ];
  const shapes = [
    (v) => `apiKeyRef: ${v}`,
    (v) => `<PasswordRef>${v}</PasswordRef>`,
    (v) => `<SecretRef>${v}</SecretRef>`,
    (v) => `secretArn: ${v}`,
    (v) => `<password_ref>${v}</password_ref>`,
  ];
  const texts = values.flatMap((v) => shapes.map((shape) => shape(v)));
  assert.deepEqual(
    texts.filter((text) => read(text) !== "quiet"),
    [],
  );
});
