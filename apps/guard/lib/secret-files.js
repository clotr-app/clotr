"use strict";
/* global require, module */

const path = require("path");

const OPENSSH_PRIVATE_KEYS = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_xmss",
  "id_rsa_sk",
  "id_ed25519_sk",
  "id_ecdsa_sk",
]);
const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
// Credential stores known by the folder they live in, matched at the end of the path, so a project's own file with
// the same name, such as a config or a settings.xml, stays an ordinary file.
const SECRET_PATHS = [
  ".kube/config",
  ".docker/config.json",
  "gh/hosts.yml",
  "github cli/hosts.yml",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  "gcloud/credentials.db",
  "gcloud/access_tokens.db",
  "gcloud/application_default_credentials.json",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".azure/msal_token_cache.json",
];

// Windows opens "name.", "name " and "name::$DATA" (any "name:stream") as the file "name", so each part of the path is
// read the way Windows would before the rules below see it.
function windowsPart(part) {
  return part.replace(/:.*$/, "").replace(/[. ]+$/, "");
}

function isSecretFile(filePath, content = "") {
  const normalized = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((part, index) => (index === 0 && /^[a-z]:$/i.test(part) ? part : windowsPart(part)))
    .join("/");
  const name = path.posix.basename(normalized).toLowerCase();
  const parent = path.posix.basename(path.posix.dirname(normalized)).toLowerCase();
  const lowered = normalized.toLowerCase();
  if (ENV_EXAMPLES.has(name)) return false;
  if (name === ".env" || name === ".envrc" || name.startsWith(".env.")) return true;
  if (
    OPENSSH_PRIVATE_KEYS.has(name) ||
    [
      ".npmrc",
      ".yarnrc",
      ".yarnrc.yml",
      ".pypirc",
      ".netrc",
      "_netrc",
      ".pgpass",
      ".my.cnf",
      ".git-credentials",
      ".dockercfg",
      ".htpasswd",
      ".s3cfg",
      ".boto",
      ".vault-token",
      ".terraformrc",
      "terraform.rc",
      ".databrickscfg",
      "winscp.ini",
      "credentials",
      "credentials.json",
      "credentials.toml",
      "credentials.tfrc.json",
      "rclone.conf",
      ".credentials.json",
      "secrets.json",
      "secrets.yaml",
      "secrets.yml",
      "secrets.toml",
      ".secrets",
      "wp-config.php",
      ".bash_history",
      ".zsh_history",
      "consolehost_history.txt",
    ].includes(name)
  ) {
    return true;
  }
  if (name === "credentials" && parent === ".aws") return true;
  if (SECRET_PATHS.some((suffix) => lowered === suffix || lowered.endsWith(`/${suffix}`))) return true;
  if (/\.(?:pem|key|p12|pfx|ppk|ovpn|tfvars|tfstate|tfstate\.backup|keystore|jks)$/i.test(name)) return true;
  if (name.startsWith("secrets.") || name.includes(".secrets.") || name === ".secrets") return true;
  return /["']type["']\s*:\s*["']service_account["']/.test(content);
}

module.exports = { isSecretFile };
