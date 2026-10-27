// Windows opens "name.", "name " and "name::$DATA" as the same file as "name", so the secret-file rules that Guard's
// read check and is_secret_file share must see through all three.
const test = require("node:test");
const assert = require("node:assert");
const { isSecretFile } = require("../apps/guard/lib/secret-files.js");

test("a secret file stays secret when Windows spellings point at the same file", () => {
  for (const name of [".env", "id_rsa", "credentials.json", "server.pem", ".npmrc"]) {
    for (const spelling of [
      `${name}.`,
      `${name}...`,
      `${name} `,
      `${name}. .`,
      `${name}::$DATA`,
      `${name}::$data`,
      `${name}:$DATA`,
      `${name}:stream`,
      `${name}:stream:$DATA`,
      `${name}.::$DATA`,
    ]) {
      assert.ok(isSecretFile(`C:\\work\\app\\${spelling}`), `${spelling} is the same file as ${name}`);
      assert.ok(isSecretFile(`/work/app/${spelling}`), `${spelling} is the same file as ${name}`);
    }
  }
  assert.ok(isSecretFile("C:\\Users\\me\\.aws\\credentials::$DATA"));
  assert.ok(isSecretFile("C:\\Users\\me\\.kube\\config."));
});

test("ordinary files and example env files keep their meaning under the same spellings", () => {
  for (const name of ["README.md", "notes.txt", ".env.example", "config"]) {
    for (const spelling of [name, `${name}.`, `${name}::$DATA`]) {
      assert.strictEqual(isSecretFile(`C:\\work\\app\\${spelling}`), false, spelling);
    }
  }
  assert.strictEqual(isSecretFile("C:\\work\\app\\.env.example."), false);
});
