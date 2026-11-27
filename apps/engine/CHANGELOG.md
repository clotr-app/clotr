# Clotr engine

## 1.6.4 (2026-11-27)

Known issue: a plain number right after a login code and "and", ", and" or "or", like
`the login code is 482913 and 551234.`, is read as a second code, so Hide it covers it too. 1.6.3 does this too.

- A password in any link with a login, like `smb://sam:hunter2!@nas.wibblecorp.io/share` or an `ssh://` link, is
  found as a connection string, and Hide it covers all of it, even with a space in the password or a stand-in link
  right before it. 1.6.3 read many of these as an email or missed them, and could leave part of the password showing.
- A stand-in password in a link, like `password` or `secret`, stays quiet, where 1.6.3 read it as an email.
- A note under a password's ref name, like `password_ref: prod database password`, stays quiet. A passphrase there,
  like `db_password_ref: correct horse battery staple`, is still found.
- A typed password that only sounds made up, like `password: example123!`, is found, and so is one under its own
  `.value`, like `db.password.value=maple_2093`.
- A key after `sessionKey:` or `authKey:` is found, and so is a crypto private key after `clave privada` and a JWK
  with a brace in a quoted value.
- A key file's path, like `apiKey: ./certs/server.pem`, stays quiet. So do the `Thanks!` in
  `I forgot what my password is. Thanks!` and a dated sentence like `backup codes are not working since 2024`.
- A phone number spelled with `nought`, `naught` or `ninty`, or with a spaced hyphen between number words, like
  `fifty - three`, is found whole.
- Hide it covers a copy of a value behind a second layer of URL encoding, like `%2530%2537`.
- `Clotr.numberRuns()` renamed some fields. `afterEnd` is now `afterPeriod`, `atEdge` is now `edgeOk`, and the kinds
  `weak` and `letter` are now `soundAlike` and `lookAlike`.

Every change in detail is in `apps/engine/docs/1.6.4-details.md` in the repo.

## 1.6.3 (2026-11-22)

Known issue: a plain number right after a login code and "and", ", and" or "or", like
`the login code is 482913 and 551234.`, is read as a second code, so Hide it covers it too.

- A Secrets Manager password is found in more of the ways it's written, like `SecretString=…` in a log line,
  `SecretString: …` in YAML or `"SecretString":"…"` in JSON. A file or a reference there stays quiet, like
  `SecretString: !Ref DbPass`. Without quotes, a password with no digit, or one with no space after the colon, is
  still missed.
- A message with two login codes, like `482913 is my verification code: 551234`, has both found and hidden. A second
  code inside an element, or one with its own name after it, is still missed.
- A setting in backticks in a sentence, like `secret: true` or `token: auto`, stays quiet. So does a one-word password
  in backticks, like `password: sunshine`, which 1.6.2 found.
- A password one level under its name in YAML is found, like a CloudFormation parameter's `Default:` or a `value:`
  under `password:`.
- A password inside an XML or HTML element is hidden without its closing tag, and a Secrets Manager ARN stays quiet.
- Under a camelCase password setting, a version range, a home path or a link to a vault stays quiet, like
  `adminPassword: ^2.3.1`. A path under `authToken:` is still flagged.

Every change in detail is in `apps/engine/docs/1.6.3-details.md` in the repo.

## 1.6.2 (2026-11-18)

Known issue: under a camelCase setting like `authToken:`, `jwtSecret:` or `dbPassword:`, a path, a URL or a timestamp
can be flagged, like `authToken: /run/secrets/db_password`. 1.6.1 flags the same value under `auth_token:`.

- A password with a digit and a symbol, or a key, under a camelCase name in YAML, JSON or XML is found, like
  `dbPassword: …`, and so is one under a name that ends in Value, Ref or Arn.
- A login code in quotes before its name, like `'482913' is my verification code`, is found.
- API tokens in 19 more formats are found with no label in front, and so are secret webhook links for Teams, Google
  Chat, IFTTT and Zapier.
- ID and tax numbers from 19 more European countries are found after their label or under a column named for them.
- A word saved in My details is found in more of the ways people type it.
- The masked preview shows less: only dots for a password, PIN or private key, and at most a quarter of anything else,
  like `AK…3N`. `mask()` takes the finding's kind as a second argument for this.
- Fewer wrong warnings on everyday numbers, image names like `icon@2x.png`, made-up stand-in keys, a key block that's
  only `…`, and `users.noreply.github.com` addresses.
- Long pastes of metric lines, blank lines or saved words take a moment again, not seconds.
- `detect()` returns an empty list for anything that isn't text, and `mask()` throws a `TypeError` for anything but a
  string.

Every change in detail is in `apps/engine/docs/1.6.2-details.md` in the repo.

## 1.6.1 (2026-11-06)

- Detection matches Clotr 1.6.1; its detection changes are in the extension's release notes.
- `ClotrHost.check` no longer makes strong history fingerprints, which made a 1,000-character check about 15 times
  slower. `ClotrHost.eventsFor` makes them when the person answers, for at most eight findings per check, with the
  same values and scheme. Its new optional fourth argument, the checked text, lets an engine started again since the
  check find the details again. Findings no longer carry `historyFp`.
- `detect()` keeps its last answer, so the same text isn't scanned twice. `redact()` given the same text takes the
  findings from that scan, and hides what the results array holds when it's called, so a finding taken out of the
  array stays visible.
- `ClotrHost.redact()` hides from `check()`'s own list for the same text, and cleans a share link instead of blanking
  it.
- A 1,000-character check takes about four fifths of the time it took in 1.6.0, even with the new rules.
- The sound-alike memo keeps only 4-to-7-letter words, so long runs of Chinese or Japanese text with no spaces no
  longer make it grow.
- The bundle loads on Node 14 again (VS Code 1.57's extension host).

## 1.6.0 (2026-10-27)

- Detection matches Clotr 1.6.0; its detection changes are in the extension's release notes.
- Long blank runs after password or login labels no longer hold up detection.
- `ClotrHost.check` makes strong history fingerprints for at most eight findings per check.
