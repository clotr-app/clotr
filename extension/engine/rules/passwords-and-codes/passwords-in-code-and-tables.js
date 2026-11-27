// Passwords in code and commands, CSV exports, markup and Markdown tables.
(() => {
  "use strict";

  const { nameRoleAlternatives, PW_WORD } = globalThis.ClotrInternal;

  // ── Passwords in code and commands ──
  // requests' auth=("user", "password") and HTTPBasicAuth("user", "password"), and SQL's IDENTIFIED BY '…'.
  const AUTH_TUPLE =
    /\b(?:auth\s*=\s*|HTTP(?:Basic|Digest)Auth\s*)\(\s*(["'])[^"'\n]{1,64}\1\s*,\s*(["'])([^"'\n]{4,128})\2\s*\)/g;
  const SQL_IDENTIFIED = /\bIDENTIFIED\s+(?:WITH\s+[\w$]+\s+)?BY\s+(?:PASSWORD\s+)?(["'])([^"'\n]{1,128})\1/gi;

  // ── Passwords in CSV exports ──
  // A CSV or tab-separated paste with a password column, like a browser's or a password manager's export:
  // "name,url,username,password" over its rows. A header cell like "password_changed" names something else, and a
  // row has to have as many cells as the header, so a sentence with commas in it under a list doesn't count.
  const PASSWORD_HEADER_WORDS =
    "password|passwd|pwd|pass|passcode|passphrase|" +
    "contrase(?:ñ|n)a|senha|passwort|kennwort|mot de passe|mdp|wachtwoord|has[łl]o|heslo|lösenord|passord|" +
    "salasana|пароль|密码|パスワード|비밀번호";
  const CSV_PASSWORD_HEAD = new RegExp(String.raw`^(?:[\p{L}\d]{1,20}[ _-])?(?:${PASSWORD_HEADER_WORDS})$`, "iu");
  // Any word a password header starts with, so a text with none skips the line by line read.
  const CSV_PASSWORD_HINT =
    /pass|pwd|mdp|contrase|senha|kennwort|wachtwoord|has[łl]o|heslo|lösenord|salasana|пароль|密码|パスワード|비밀번호/i;

  function csvCells(line, separator) {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (quoted) {
        if (character === '"' && line[index + 1] === '"') {
          cell += '"';
          index++;
        } else if (character === '"') quoted = false;
        else cell += character;
      } else if (character === '"' && !cell.trim()) {
        quoted = true;
        cell = "";
      } else if (character === separator) {
        cells.push(cell.trim());
        cell = "";
      } else cell += character;
    }
    cells.push(cell.trim());
    return cells;
  }

  function csvPasswords(text) {
    if (!/[,;\t]/.test(text) || !CSV_PASSWORD_HINT.test(text)) return [];
    const lines = text.split(/\r?\n/);
    const passwords = [];
    for (let headerIndex = 0; headerIndex + 1 < lines.length; headerIndex++) {
      const line = lines[headerIndex];
      const [tabs, semicolons, commas] = ["\t", ";", ","].map((separator) => line.split(separator).length - 1);
      let separator = "";
      if (tabs) separator = "\t";
      else if (semicolons > commas) separator = ";";
      else if (commas) separator = ",";
      if (!separator) continue;

      const header = csvCells(line, separator);
      const passwordColumn = header.findIndex((cell) => CSV_PASSWORD_HEAD.test(cell));
      if (passwordColumn < 0 || header.some((cell) => cell.length > 32)) continue;
      let rowIndex = headerIndex + 1;
      for (; rowIndex < lines.length; rowIndex++) {
        // A rich chat box reads each pasted line back as its own paragraph, with a blank line between rows.
        if (!lines[rowIndex].trim()) continue;
        const row = csvCells(lines[rowIndex], separator);
        if (row.length !== header.length) break;
        const password = row[passwordColumn];
        if (password && !/\s/.test(password)) passwords.push(password);
      }
      headerIndex = rowIndex - 1; // each row is read once, under the nearest header above it
    }
    return passwords;
  }

  // ── Passwords in messages and markup ──
  // "login is alex99, and it's …" or "username alex99 the password is …".
  const LOGIN_NAMED = String.raw`\b(?:log-?in|user(?:\s*name)?)\s+(?:is\s+)?["']?[^\s"']{2,64}["']?`;
  const THEN_PASSWORD = String.raw`(?:\s*,\s*|\s+)(?:and\s+)?(?:it['’]s|it\s+is|the\s+password\s+is|password\s+is)`;
  const LOGIN_THEN_SECRET = new RegExp(String.raw`${LOGIN_NAMED}${THEN_PASSWORD}\s+["'“‘]?([^\s"'”’,;!?]+)`, "gi");
  // "use hunter2 as the new password", but not "… as the password manager".
  const USE_VALUE = String.raw`(?<![\p{L}\d])(?:use|using|try|enter)\s+["'“‘]?([^\s"'”’]{4,64})["'”’]?`;
  const AS_THE = String.raw`\s+as\s+(?:the|my|your|a|our)\s+(?:new\s+)?`;
  const PASSWORD_THINGS = "manager|reset|hint|field|box|generator|vault|app|policy|rule|requirement";
  const USE_AS_SECRET = new RegExp(
    String.raw`${USE_VALUE}${AS_THE}${PW_WORD}(?![\p{L}]|\s+(?:${PASSWORD_THINGS})s?(?![\p{L}]))`,
    "giu",
  );
  const USER_PASS = /\b(?:user(?:name)?|login)\s+[^\s:=]{2,64}\s+(?:pass|pw|pwd)\s+["']?([^\s"',;]+)/gi;
  const MYSQL_FLAG =
    /\b(?:mysql(?:dump|admin|import|show|check)?|mariadb(?:-dump)?)\b[^\n]{0,200}?\s-p(["']?)([^\s"']+)\1(?=\s|$)/g;
  // An element named for the secret, or for the secret and then role words (nameRoleWords): <password>,
  // <SecretValue>, <PasswordRef>, <secret_arn>. Under role words the value has to read as one (roleNameValueReads).
  const XML_SECRET = new RegExp(
    String.raw`<((?:password|passwd|pwd|secret)((?:[_-]?(?:${nameRoleAlternatives()}))*))>([^<>\s]{4,128})<\/\1>`,
    "gi",
  );
  const PASSWORD_BOX =
    /<input\b(?=[^>]{0,300}\btype\s*=\s*["']?password\b)[^>]{0,300}?\bvalue\s*=\s*(["'])([^"'\n]{4,128})\1/gi;
  const SECURE_STRING = /\bConvertTo-SecureString\s+(?:-String\s+)?(["'])([^"'\n]{4,128})\1\s+-AsPlainText\b/gi;

  // ── Passwords in Markdown tables ──
  // A Markdown table with a password column, as in "| user | password |" over "| bob | Tr0ub4dor&3x |". A column
  // of yes and no answers stays quiet, since a cell has to look like a password.
  const TABLE_PASSWORD_HEAD = /^(?:password|passwd|pwd|pass|passcode|contrase(?:ñ|n)a|clave|passwort|mot de passe)$/i;
  function tablePasswords(text) {
    if (!/\|/.test(text) || !/\|[^\S\n]*(?:pass|pwd|contrase|clave|mot de passe)/i.test(text)) return [];
    const tableCells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
    // Made only of spaces, "|", ":" and "-", with three dashes in a row. Written as one pattern, the dashes could be
    // split three ways, and a long line of them that ended in anything else took time growing with its length cubed.
    const ruleLine = (line) => /^[\s|:-]*$/.test(line) && line.includes("---");

    const lines = text.split("\n");
    const passwords = [];
    for (let headerIndex = 0; headerIndex + 1 < lines.length; headerIndex++) {
      if (!lines[headerIndex].includes("|") || !ruleLine(lines[headerIndex + 1])) continue;
      const passwordColumn = tableCells(lines[headerIndex]).findIndex((cell) => TABLE_PASSWORD_HEAD.test(cell));
      if (passwordColumn < 0) continue;
      let rowIndex = headerIndex + 2;
      for (; rowIndex < lines.length && lines[rowIndex].includes("|"); rowIndex++) {
        const password = tableCells(lines[rowIndex])[passwordColumn];
        if (password) passwords.push(password);
      }
      headerIndex = rowIndex - 1; // each row is read once, under the nearest header above it
    }
    return passwords;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    AUTH_TUPLE,
    SQL_IDENTIFIED,
    csvPasswords,
    LOGIN_THEN_SECRET,
    USE_AS_SECRET,
    USER_PASS,
    MYSQL_FLAG,
    XML_SECRET,
    PASSWORD_BOX,
    SECURE_STRING,
    tablePasswords,
  };
})();
