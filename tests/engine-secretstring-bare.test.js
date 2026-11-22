// An unquoted password after SecretString= or SecretString: is read the way an unquoted password after password= or
// password: is, in a log line, YAML, a .properties or .env line and a shell export. Values that aren't a password stay
// quiet. Every value here is made up and joined at run time.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect, redact } = globalThis.Clotr;

const pw = ["Tr0ub4", "dor&3x"].join("");
const pw2 = ["Winter", "2025!Qx"].join("");
const pw3 = ["hX7", "kq2", "Lp9zB"].join("");
const arn = ["arn:aws:secrets", "manager:us-east-1:", "123456789012", ":secret:prod/db-AbCdEf"].join("");
const passwords = (results) => results.filter((r) => r.id === "password").flatMap((r) => r.matches);

const FOUND = [
  [`PutSecretValue request: SecretId=${arn}, SecretString=${pw}`, pw],
  [`PutSecretValue request: SecretId=${arn} SecretString=${pw2}`, pw2],
  [`PutSecretValue request: SecretId=prod/db, SecretString=${pw3}`, pw3],
  [`SecretString=${pw}`, pw],
  [`2026-11-18T10:22:31Z INFO PutSecretValue SecretString=${pw2} ok`, pw2],
  [`SecretString: ${pw2}`, pw2],
  [`Resources:\n  DbSecret:\n    Type: AWS::SecretsManager::Secret\n    Properties:\n      SecretString: ${pw}`, pw],
  [`Resources:\n  DbSecret:\n    Properties:\n      SecretString:\n        ${pw3}`, pw3],
  [`Resources:\n  AppSecret:\n    Properties:\n      ExistingSecret: ${arn}\n      SecretString: ${pw}`, pw],
  [`aws.secretsmanager.SecretString=${pw3}`, pw3],
  [`SecretString = ${pw}`, pw],
  [`AWS_REGION=us-east-1\nSecretString=${pw2}\nLOG_LEVEL=info`, pw2],
  [`SECRETSTRING=${pw3}`, pw3],
  [`export SecretString=${pw}`, pw],
];

for (const [text, value] of FOUND) {
  test(`an unquoted SecretString password is found and hidden: ${JSON.stringify(text.replace(value, "<value>"))}`, () => {
    const results = detect(text);
    assert.deepEqual(passwords(results), [value]);
    assert.ok(!redact(text, results).includes(value.slice(0, 5)), "Hide it left the password");
  });
}

// The log line with an ARN before the password: Hide it covers the password and leaves the ARN, which names the secret.
test("Hide it on a PutSecretValue log line covers the password and leaves the ARN", () => {
  const text = `PutSecretValue request: SecretId=${arn}, SecretString=${pw}`;
  const hidden = redact(text, detect(text));
  assert.ok(!hidden.includes(pw.slice(0, 5)), "Hide it left the password");
  assert.ok(hidden.includes(arn), "Hide it changed the ARN");
});

const QUIET = [
  "SecretString=file://secret.json",
  "PutSecretValue request: SecretId=prod/db, SecretString=fileb://secret.bin",
  "SecretString=$DB_PW",
  "SecretString=${DB_PW}",
  "SecretString: {{ .Values.dbPassword }}",
  "SecretString: <placeholder>",
  "SecretString: !Sub '${DbPass}'",
  "SecretString: !Ref DbPasswordParam",
  `SecretString: ${arn}`,
  'SecretString={"username":"admin"}',
  "SecretString:\n  Ref: DbSecretParam",
  "Password: !Sub '{{resolve:secretsmanager:${DbSecret}:SecretString:password}}'",
  "client.put_secret_value(SecretId=arn, SecretString=creds_json)",
  "client.put_secret_value(\n    SecretId=arn,\n    SecretString=new_secret,\n)",
  "the SecretString field holds the JSON",
  "Set SecretString: to your JSON blob",
  "SecretString: string (optional)",
  "SecretString: 2026-11-18",
  "rotated at SecretString=10:22:31",
];

for (const text of QUIET) {
  test(`a SecretString with no password stays quiet: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(passwords(detect(text)), []);
  });
}
