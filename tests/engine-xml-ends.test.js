// A password inside an XML element is found without the element's closing tag, and the "secret:" inside a Secrets
// Manager ARN isn't read as a label. Every value here is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect } = globalThis.Clotr;

const PW = "Maple7!river";
const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf";
const secretFindings = (text) => detect(text).filter((r) => r.id === "password" || r.id === "service_token");

// The label sits inside the element, so the element's closing tag isn't part of the value.
const INSIDE = [
  [`<note>password: ${PW}</note>`, "password", PW],
  [`<note lang="en">password: ${PW}</note>`, "password", PW],
  [`<root><note>password: ${PW}</note></root>`, "password", PW],
  [`<note>\n  password: ${PW}</note>`, "password", PW],
  [`<x:note>password: ${PW}</x:note>`, "password", PW],
  ["<cfg>api_key: Zr8Kq2Lw9Vx4Np7T</cfg>", "service_token", "Zr8Kq2Lw9Vx4Np7T"],
  [`<p>Use secret=${PW}</p> today.`, "password", PW],
];

for (const [text, id, value] of INSIDE) {
  test(`a value inside an element is found without its closing tag: ${text}`, () => {
    const result = detect(text).find((r) => r.id === id);
    assert.ok(result, `no ${id} finding`);
    assert.equal(result.severity, "high");
    assert.deepEqual(result.matches, [value]);
  });
}

// The label isn't inside an element of that name, so nothing is dropped and the value reads as it did.
const OUTSIDE = [
  [`password: ${PW}</note>`, `${PW}</note>`],
  [`<a>password: ${PW}</note>`, `${PW}</note>`],
  [`<note></note>password: ${PW}</note>`, `${PW}</note>`],
  [`<notes>password: ${PW}</note>`, `${PW}</note>`],
];

for (const [text, value] of OUTSIDE) {
  test(`a closing tag stays when the label isn't inside that element: ${text}`, () => {
    const result = detect(text).find((r) => r.id === "password");
    assert.ok(result, "no password finding");
    assert.deepEqual(result.matches, [value]);
  });
}

// A Secrets Manager ARN names where a secret is kept. Its "secret:" is the resource type, not a label.
const ARNS = [
  ARN,
  `<secretArn>${ARN}</secretArn>`,
  `secretArn: ${ARN}`,
  `secret_arn: ${ARN}`,
  `"SecretId": "${ARN}"`,
  `aws secretsmanager get-secret-value --secret-id ${ARN}`,
  "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:prod/db-AbCdEf",
  "arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:app-key-Xy12Zq",
  // A secret's name can hold "=", so a label word inside the name is still the name.
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:app/api_key=v2-AbCdEf",
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/password=rotated-AbCdEf",
  `${ARN}?versionStage=AWSCURRENT`,
];

for (const text of ARNS) {
  test(`a Secrets Manager ARN is quiet: ${text}`, () => {
    assert.deepEqual(secretFindings(text), []);
  });
}

// A real secret next to an ARN, or after a "secret:" that isn't an ARN's, is still found.
const STILL = [
  [`${ARN}\npassword: ${PW}`, "password", PW],
  [`secret: ${PW}`, "password", PW],
  [`app:secret: ${PW}`, "password", PW],
  [`arn:secret: ${PW}`, "password", PW],
  // Inside an ARN the resource follows its type with no space, so a "secret: …" after one is a label.
  [`arn:aws:s3:::secret: ${PW}`, "password", PW],
  [`arn:aws:secretsmanager:us-east-1:123456789012:secret: ${PW}`, "password", PW],
];

for (const [text, id, value] of STILL) {
  test(`a secret beside an ARN is still found: ${text}`, () => {
    const result = detect(text).find((r) => r.id === id);
    assert.ok(result, `no ${id} finding`);
    assert.deepEqual(result.matches, [value]);
  });
}

// The backtick rows keep the answer the backtick fix gave them.
test("a setting in backticks stays quiet", () => {
  assert.deepEqual(secretFindings("The job gets `id-token: write` and then runs."), []);
});

test("a password in backticks is still found without them", () => {
  const result = detect(`Set \`password: ${PW}\` in the file.`).find((r) => r.id === "password");
  assert.ok(result);
  assert.deepEqual(result.matches, [PW]);
});

// A value that reads as a secret only with its tag on is still found, tag and all, as it was before.
const ONLY_WITH_TAG = [
  ["<note>pin: 12</note>", "password", "12</note>"],
  ["<note>password: abc</note>", "password", "abc</note>"],
  ["<li>api_key: Zr8Kq2Lw9Vx4</li>", "service_token", "Zr8Kq2Lw9Vx4</li>"],
];

for (const [text, id, value] of ONLY_WITH_TAG) {
  test(`a value found only with its tag is still found: ${text}`, () => {
    const results = secretFindings(text);
    assert.deepEqual(
      results.map((r) => [r.id, r.matches]),
      [[id, [value]]],
    );
  });
}

test("a key inside an element is one service token, not a password too", () => {
  const results = secretFindings("<cfg>api_key: Zr8Kq2Lw9Vx4Np7T</cfg>");
  assert.deepEqual(
    results.map((r) => [r.id, r.matches]),
    [["service_token", ["Zr8Kq2Lw9Vx4Np7T"]]],
  );
});

// A password or token written right after an ARN's name is found, whatever joins it to the name, and Hide it
// covers it. The values are made up and joined here, at run time.
const pw = ["Tz4#", "quill", "Rov3r"].join("");
const pw2 = ["Brk9$", "lantern", "22"].join("");
const tok = ["hG7pQ", "2vXm", "Lw8sN4"].join("");
const smArn = ["arn:aws:secretsmanager:us-east-1:", "123456789012", ":secret:prod-AbCdEf"].join("");
const AFTER_NAME = [
  [`${smArn}password=${pw}`, pw],
  [`https://example.test/cb?arn=${smArn}&password=${pw}`, pw],
  [`${smArn}|password=${pw}`, pw],
  [`${smArn}&token=${tok}`, tok],
  [`${smArn}/password=${pw}`, pw],
  [`${smArn}?password=${pw}`, pw],
  [`SecretId=${smArn}&Password=${pw2}&Action=Rotate`, pw2],
  [`jdbc:secretsmanager:mysql://db:3306/app?user=${smArn}&password=${pw2}`, pw2],
];

for (const [text, value] of AFTER_NAME) {
  test(`a password right after an ARN's name is found and hidden: ${text.replace(value, "<value>")}`, () => {
    const results = detect(text);
    const found = results.filter((r) => r.id === "password").flatMap((r) => r.matches);
    assert.ok(
      found.some((match) => match.includes(value)),
      "no password finding",
    );
    assert.ok(!globalThis.Clotr.redact(text, results).includes(value.slice(0, 5)), "Hide it left the value");
    assert.ok(!found.some((match) => match.includes("prod-AbCdEf")), "the ARN's name was read as the password");
  });
}

// A Secrets Manager call with the secret under SecretString right after the ARN, as an SDK body, a log line or a
// query, is found and Hide it covers it. The values are made up and joined here, at run time.
const pw3 = ["Fen", "!ix", "88", "dove"].join("");
const dbArn = ["arn:aws:secretsmanager:us-east-1:", "123456789012", ":secret:prod/db-AbCdEf"].join("");
const SECRET_STRING = [
  [`{"SecretId":"${dbArn}","SecretString":"${pw}"}`, pw, true],
  [`[DEBUG] PutSecretValue request: SecretId=${dbArn}&SecretString=${tok}`, tok, true],
  [`Action=PutSecretValue&SecretId=${smArn}&SecretString=${pw2}`, pw2, true],
  // An escaped JSON secret inside SecretString is found as the ARN's run, the way it was read before.
  [`{"SecretId":"${smArn}","SecretString":"{\\"password\\":\\"${pw}\\"}"}`, pw, false],
  [`{"SecretId":"${dbArn}","SecretString":"{\\"password\\":\\"${pw3}\\"}"}`, pw3, false],
];

for (const [text, value, alone] of SECRET_STRING) {
  test(`a secret under SecretString after an ARN is found and hidden: ${text.replace(value, "<value>")}`, () => {
    const results = detect(text);
    const found = results.filter((r) => r.id === "password").flatMap((r) => r.matches);
    assert.ok(
      found.some((match) => match.includes(value)),
      "no password finding",
    );
    assert.ok(!globalThis.Clotr.redact(text, results).includes(value.slice(0, 5)), "Hide it left the value");
    if (alone) assert.deepEqual(found, [value]);
  });
}

// The same calls with no secret in them stay quiet.
const NO_SECRET_STRING = [
  `{"SecretId":"${dbArn}","VersionStage":"AWSCURRENT"}`,
  `{"SecretId":"${dbArn}","SecretString":""}`,
  `Action=GetSecretValue&SecretId=${smArn}&VersionStage=AWSCURRENT`,
  // A label word inside another JSON key after the ARN isn't a label.
  `{"SecretId":"${dbArn}","oldpwd":"/srv/app"}`,
  `{"SecretId":"${dbArn}","spin":"4821"}`,
  `{"SecretId":"${dbArn}","csrftoken":"abc123"}`,
  `{"SecretId":"arn:aws:secretsmanager:us-east-1:123456789012:secret:app/api_key=v2-AbCdEf","VersionStage":"AWSCURRENT"}`,
];

for (const text of NO_SECRET_STRING) {
  test(`an ARN in a call with no secret stays quiet: ${text}`, () => {
    assert.deepEqual(secretFindings(text), []);
  });
}

// A CloudFormation SecretString whose value is a function on the next line, or a variable passed to an SDK call,
// isn't a secret, so it stays quiet.
const SECRET_STRING_NOT_A_VALUE = [
  'SecretString:\n  Fn::Sub: \'{"username":"admin"}\'',
  "SecretString:\n  Fn::Join:\n    - ''\n    - - '{\"username\":\"admin\"}'",
  "SecretString:\n  Ref: DbSecretParam",
  'Resources:\n  DbSecret:\n    Type: AWS::SecretsManager::Secret\n    Properties:\n      SecretString:\n        Fn::Sub: \'{"username":"${User}"}\'',
  "sm.update_secret(SecretId=arn, SecretString=creds_json)",
  "client.put_secret_value(SecretId=secret_arn, SecretString=payload_json)",
  "sm.create_secret(Name='prod/db', SecretString=db_creds)",
];

for (const text of SECRET_STRING_NOT_A_VALUE) {
  test(`a SecretString with no value written in stays quiet: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(secretFindings(text), []);
  });
}

// A quoted SecretString value, or one after ? or & in a query, is still found and hidden.
const SECRET_STRING_VALUE = [
  `{"SecretString":"${pw3}"}`,
  `SecretString: '${pw3}'`,
  `sm.put_secret_value(SecretId=arn, SecretString="${pw3}")`,
  `Action=PutSecretValue&SecretString=${pw3}&VersionStages=AWSCURRENT`,
  `https://example.com/?SecretString=${pw3}`,
];

for (const text of SECRET_STRING_VALUE) {
  test(`a written-in SecretString value is found and hidden: ${text.replace(pw3, "<value>")}`, () => {
    const results = detect(text);
    const found = results.filter((r) => r.id === "password").flatMap((r) => r.matches);
    assert.ok(
      found.some((match) => match.includes(pw3)),
      "no password finding",
    );
    assert.ok(!globalThis.Clotr.redact(text, results).includes(pw3.slice(0, 5)), "Hide it left the value");
  });
}
