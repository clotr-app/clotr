# Clotr engine

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
