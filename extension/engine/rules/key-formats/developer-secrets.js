// Developer secrets with a fixed format: connection strings with a password, private IP addresses, internal
// hostnames and AWS access keys.
(() => {
  "use strict";

  const { trimTrail, isPlaceholder, linkPasswordBlank, linkPasswordStandIn, looksRandom, lastItem } =
    globalThis.ClotrInternal;

  // ---------- Developer secrets: connection strings, JWTs, internal addresses ----------
  // ── Connection strings ────────────────────────────
  // scheme://user:password@host for any scheme (ssh://, smb://, ldap://, …), matched only when the
  // password looks real. A driver can follow the scheme (SQLAlchemy's postgresql+psycopg2://), and the
  // user name can hold an "@", as in Azure's user@server, typed as is or as user%40server.

  // The scheme is captured without its driver. Bounded, so a long run of letters and dots isn't rescanned.
  const CONNECTION_SCHEME_RE = /\b([a-z][a-z0-9+.-]{0,31}?)(?:\+[a-z][a-z0-9_]{0,23})?:\/\//gi;
  // A file link or an extension's page names a place on this computer, never a login.
  const NOT_LOGIN_SCHEMES = new Set(["file", "chrome-extension", "moz-extension"]);
  // The database, web, file-transfer and mail schemes the rule began with.
  const FIRST_SCHEMES = new Set([
    "postgres",
    "postgresql",
    "mysql",
    "mariadb",
    "mongodb",
    "redis",
    "rediss",
    "amqp",
    "amqps",
    "mssql",
    "sqlserver",
    "oracle",
    "ftp",
    "sftp",
    "smtp",
    "http",
    "https",
  ]);
  const CONNECTION_USER_END = /[\s:/]/;
  const CONNECTION_PASSWORD_END = /[\s@]/;
  const CONNECTION_HOST_END = /[\s"'<>]/;
  const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(?![\w.-])/i;

  // A password typed by hand can hold a space, as in sftp://alex:my pass@files.example.com. Past a space it
  // runs on to the "@" only where it can't be prose: a few words one space apart on one line, none of a
  // link's or a quote's marks, no sentence going on, no port first, and a real host after the "@".
  const SPACED_PASSWORD_LONGEST = 40;
  const SPACED_PASSWORD_WORDS = 4;
  const SPACED_PASSWORD = /^[^\s/?#"'`<>()[\]{}\\@]+(?: [^\s/?#"'`<>()[\]{}\\@]+)+$/;
  const SENTENCE_GOES_ON = /[.,;:!] /;
  const PORT_FIRST = /^\d{1,5}(?!\w)/;
  // A dotted name or address, localhost, an IPv6 address, or one name with a port or path after it.
  // "@sam" alone is someone's handle.
  const SPACED_PASSWORD_HOST = /(?:[a-z\d-]+(?:\.[a-z\d-]+)+|localhost|\[[\da-f:.]+\]|[a-z\d-]+(?=:\d|\/))/iy;

  // For every position, where the next "@" or space is. Passwords can hold slashes, so a failed candidate finds
  // its next "@" here instead of rescanning the text.
  function passwordEndAt(text) {
    const nextEnd = new Int32Array(text.length + 1);
    let end = text.length;
    for (let i = text.length - 1; i >= 0; i--) {
      // Plain ASCII without a regex: "@", or a space, tab or line break (\s's ASCII members, 9 to 13 and 32).
      const code = text.charCodeAt(i);
      const isEnd =
        code < 128 ? code === 64 || code === 32 || (code >= 9 && code <= 13) : CONNECTION_PASSWORD_END.test(text[i]);
      if (isEnd) end = i;
      nextEnd[i] = end;
    }
    nextEnd[text.length] = text.length;
    return nextEnd;
  }

  // Where a password with a space ends: the "@" after it, or -1 when the run isn't a password.
  function spacedPasswordEnd(text, passwordStart) {
    const nearby = text.slice(passwordStart, passwordStart + SPACED_PASSWORD_LONGEST + 1);
    const at = nearby.indexOf("@");
    if (at < 0) return -1;
    const password = nearby.slice(0, at);
    if (!SPACED_PASSWORD.test(password)) return -1;
    if (password.split(" ").length > SPACED_PASSWORD_WORDS) return -1;
    if (SENTENCE_GOES_ON.test(password) || PORT_FIRST.test(password)) return -1;
    SPACED_PASSWORD_HOST.lastIndex = passwordStart + at + 1;
    if (!SPACED_PASSWORD_HOST.test(text)) return -1;
    return passwordStart + at;
  }

  // Whether the part between the colon and the "@" is a password at all.
  function isLogin(scheme, user, password) {
    // With an "@" in the user name, "https://me@host:8080/a@b" is a host and port, not a password.
    if (user.includes("@") && /^\d{1,5}(?:\/|$)/.test(password)) return false;
    if (FIRST_SCHEMES.has(scheme)) return true;
    // Past the first schemes, a port or a path can sit there instead. "svn://host:3690/trunk@1234" is
    // a revision, "ssh://deploy@host:/srv/@acme/ui" a folder, "git+ssh://git@host:acme/app.git@v1" a tag.
    if (/^\d{0,5}\//.test(password)) return false;
    return !/^(?:git|hg)@/i.test(user);
  }

  function connectionLooksReal(user, password, host) {
    // A database's out-of-the-box login on this machine, like postgres:postgres@localhost in a docker-compose file,
    // opens nothing anyone else can reach. The same login on another host does.
    const sameAsUser = user.length > 0 && user.toLowerCase() === password.toLowerCase();
    if (sameAsUser && LOOPBACK_HOST.test(host)) return false;
    return !linkPasswordStandIn(password);
  }

  // Every scheme://user:password@host in the text that is a login, a stand-in password's too: where it
  // starts and ends, the "@" that ends its password, and whether it looks real.
  function linkLogins(text) {
    const schemes = text.matchAll(CONNECTION_SCHEME_RE);
    const firstScheme = schemes.next();
    if (firstScheme.done || text.indexOf("@") < 0) return [];
    const nextPasswordEnd = passwordEndAt(text);
    const logins = [];
    // Only a real login skips the links inside it, since its match covers them.
    // A link that isn't a login, like ws://host:8080/ws, or a stand-in login, like
    // postgres://user:password@localhost, leaves the rest of its run to be read,
    // so a database link right after it in compact JSON or a comma list is found.
    let afterMatch = 0;
    // Where the last host scan began and stopped. Every start inside that run ends at the same place, so links
    // that aren't logins, side by side, don't each rescan the rest of a long run.
    let hostRunStart = -1;
    let hostRunEnd = -1;
    for (let current = firstScheme; !current.done; current = schemes.next()) {
      const scheme = current.value;
      if (scheme.index < afterMatch) continue;
      const schemeName = scheme[1].toLowerCase();
      if (NOT_LOGIN_SCHEMES.has(schemeName)) continue;
      const userStart = scheme.index + scheme[0].length;
      let colon = userStart;
      while (colon < text.length && !CONNECTION_USER_END.test(text[colon])) colon++;
      if (text[colon] !== ":") continue;

      const passwordStart = colon + 1;
      let at = nextPasswordEnd[passwordStart];
      if (at === passwordStart) continue;
      if (text[at] === " ") at = spacedPasswordEnd(text, passwordStart);
      if (at < 0 || text[at] !== "@") continue;
      const hostStart = at + 1;
      if (hostStart === text.length || CONNECTION_HOST_END.test(text[hostStart])) continue;
      if (hostStart < hostRunStart || hostStart >= hostRunEnd) {
        hostRunStart = hostStart;
        hostRunEnd = hostStart + 1;
        while (hostRunEnd < text.length && !CONNECTION_HOST_END.test(text[hostRunEnd])) hostRunEnd++;
      }
      const end = hostRunEnd;

      const user = text.slice(userStart, colon);
      const password = text.slice(passwordStart, at);
      if (!isLogin(schemeName, user, password)) continue;
      const host = text.slice(hostStart, end);
      const real = connectionLooksReal(user, password, host);
      if (real) afterMatch = end;
      logins.push({ start: scheme.index, end, at, user, password, host, real });
    }
    return logins;
  }

  function findConnectionStrings(text) {
    const found = [];
    for (const login of linkLogins(text)) {
      if (!login.real) continue;
      found.push(trimTrail(text.slice(login.start, login.end), /[.,;)\]]/));
    }
    return found;
  }

  // Where each link login's password ends. The email reading skips an address whose "@" is one of these:
  // "sunshine9@server.example.com" in ssh://alex:sunshine9@server.example.com is a password and a host.
  // A blank like $DB_PASS isn't read as a password at all, so its "@" is left to the email reading.
  function linkPasswordEnds(text) {
    const readAsPasswords = linkLogins(text).filter((login) => !linkPasswordBlank(login.password));
    return new Set(readAsPasswords.map((login) => login.at));
  }

  // ── JWTs ──────────────────────────────────────────
  // header.payload.signature, where both JSON parts are base64url and start with "eyJ".
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

  // ── Private IP addresses ──────────────────────────
  // The private ranges 10/8, 172.16/12 and 192.168/16, but not inside a longer dotted number.
  const IP_RE = /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g;
  // A version, firmware or build number is dotted the same way: "Firmware 10.5.14.31", "upgrade from 10.2.3.4",
  // "v10.1.2.3". The version word has to be right before the number, or an upgrade word and "from" or "to" a
  // package name back. "the new version is up on 10.2.3.4" and "build server at 10.2.3.4" are still servers.
  const VERSION_WORDS = String.raw`version|ver|firmware|fw|build|release[ds]?|rev|revision|kernel|sdk`;
  const UPGRADE_WORDS = String.raw`upgrade[ds]?|upgrading|downgrade[ds]?|bump(?:ed|s|ing)?`;
  const VERSION_BEFORE_RE = new RegExp(
    String.raw`(?:(?<![\p{L}])(?:${VERSION_WORDS})(?:\s+(?:is|was|number|no\.?))?` +
      // "upgrade from", "bumped openssl to"
      String.raw`|(?<![\p{L}])(?:${UPGRADE_WORDS})(?:\s+[^\s\d]\S{0,40})?\s+(?:from|to))[\s:=#[(]*v?$`,
    "iu",
  );

  function findInternalIPs(text) {
    const found = [];
    let versionEnd = -1;
    for (const match of text.matchAll(IP_RE)) {
      if (!match[0].split(".").every((octet) => Number(octet) <= 255)) continue;
      const before = text.slice(Math.max(0, match.index - 60), match.index);
      // The "to" side of "from 10.2.3.4 to 10.2.3.5" is a version too.
      const versionTo = versionEnd >= 0 && /^\s*(?:to|->|→|=>)\s*v?$/i.test(text.slice(versionEnd, match.index));
      const versionLike = /(?<![\p{L}])v$/iu.test(before) || VERSION_BEFORE_RE.test(before) || versionTo;
      if (versionLike) {
        versionEnd = match.index + match[0].length;
        continue;
      }
      found.push(match[0]);
    }
    return found;
  }

  // ── Internal hostnames ────────────────────────────
  // Hostnames on internal-only domains, like build-01.corp, printer.local or api.internal.
  const HOST_LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
  const INTERNAL_ENDINGS = String.raw`internal|corp|local|lan|intranet|localdomain|home\.arpa`;
  const HOST_RE = new RegExp(String.raw`\b(?:${HOST_LABEL}\.){1,8}(?:${INTERNAL_ENDINGS})\b(?![.-]?\w)`, "gi");
  // Code reads like an internal hostname too. These aren't hosts: an import or namespace
  // (kotlinx.coroutines.internal, Microsoft.AspNetCore.Internal), a member in code (this.internal, node.local = true),
  // a Django settings.local module, and the names Docker and Kubernetes give every install
  // (host.docker.internal, redis.default.svc.cluster.local).
  const PLATFORM_HOST =
    /^(?:(?:host|gateway|kubernetes)\.docker\.internal|.*\.cluster\.local|(?:\w+\.)?settings\.local)$/i;
  const CODE_LINE = /(?:^|\n)\s*(?:import|from|using|package|namespace|@import|#include)\s[^\n]*$/;
  const REVERSE_DNS_START = /^(?:com|org|net|io|dev|co|me|uk|de|kotlinx|kotlin|java|javax|android|androidx|jakarta)$/i;
  const MEMBER_OWNER =
    /^(?:this|self|spec|node|t|e|n|r|o|s|ctx|props|state|module|exports|window|document|opts|options|cfg|config)$/;
  const MEMBER_ALWAYS = /^(?:this|self)$/;

  // "spec.local" read or set in code: `if(spec.local)`, `node.local = true`, `return opts.local;`.
  function memberUseInCode(owner, before, after) {
    if (MEMBER_ALWAYS.test(owner)) return true;
    if (/^\s*(?:=(?!=)|[);?,}\]&|])/.test(after)) return true;
    return /(?:[(!]|\b(?:return|if|typeof))\s*$/.test(before);
  }

  function isCodeHostname(text, at, host) {
    if (PLATFORM_HOST.test(host)) return true;
    const labels = host.split(".");
    // camelCase or a capitalised last part, as in Microsoft.AspNetCore.Internal.
    if (labels.some((part) => /[a-z][A-Z]/.test(part))) return true;
    if (/^[A-Z][a-z]+$/.test(lastItem(labels))) return true;
    if (labels.length >= 3 && REVERSE_DNS_START.test(labels[0])) return true;
    const before = text.slice(Math.max(0, at - 200), at);
    if (CODE_LINE.test(before)) return true;
    if (labels.length !== 2 || !MEMBER_OWNER.test(labels[0])) return false;
    const after = text.slice(at + host.length, at + host.length + 3);
    return memberUseInCode(labels[0], before, after);
  }

  function findInternalHosts(text) {
    return [...text.matchAll(HOST_RE)]
      .filter((match) => !isCodeHostname(text, match.index, match[0]))
      .map((match) => match[0]);
  }

  // ── AWS access keys ───────────────────────────────
  // An AWS secret access key only has a recognisable shape beside its access key ID.
  const AWS_PAIR_DISTANCE = 200;
  const AWS_ACCESS_ID_RE = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
  const AWS_PAIRED_ID_RE = /\bAWS_ACCESS_KEY_ID\s*=\s*((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g;
  const AWS_SECRET_LABELLED_RE = /\bAWS_SECRET_ACCESS_KEY\s*=\s*["']?([A-Za-z0-9/+=]{40})["']?(?![A-Za-z0-9/+=])/g;
  const AWS_SECRET_SHAPE_RE = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

  function findAwsAccessKeys(text) {
    const readable = text.replace(/\\(["\\])/g, "$1");
    const accessIds = [...readable.matchAll(AWS_ACCESS_ID_RE)];
    const pairedIds = [...readable.matchAll(AWS_PAIRED_ID_RE)];
    const found = accessIds.map((match) => match[0]);

    // Both come in the order they're written, so the first ID close enough before a secret only moves forward.
    let nextPaired = 0;
    for (const secret of readable.matchAll(AWS_SECRET_LABELLED_RE)) {
      const from = secret.index - AWS_PAIR_DISTANCE;
      while (nextPaired < pairedIds.length && pairedIds[nextPaired].index < from) nextPaired++;
      const near = pairedIds[nextPaired]?.index <= secret.index + AWS_PAIR_DISTANCE;
      if (near && !isPlaceholder(secret[1]) && looksRandom(secret[1])) found.push(secret[1]);
    }

    // People paste both halves together, and the secret often has no label: "access key AKIA… and secret key" with
    // the secret on the next line, the two side by side, or a table row under the ID. A 40-character value of mixed
    // case and digits a few lines from an access key ID is that secret. One that's all hex is a commit or a
    // checksum, and looksRandom leaves those out.
    if (accessIds.length) {
      let nextId = 0;
      for (const secret of readable.matchAll(AWS_SECRET_SHAPE_RE)) {
        const from = secret.index - AWS_PAIR_DISTANCE;
        while (nextId < accessIds.length && accessIds[nextId].index < from) nextId++;
        const near = accessIds[nextId]?.index <= secret.index + AWS_PAIR_DISTANCE;
        if (near && looksRandom(secret[0]) && !isPlaceholder(secret[0])) found.push(secret[0]);
      }
    }
    return [...new Set(found)];
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    findConnectionStrings,
    linkPasswordEnds,
    JWT_RE,
    findInternalIPs,
    findInternalHosts,
    findAwsAccessKeys,
  };
})();
