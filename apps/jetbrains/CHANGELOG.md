# Changelog

## 0.1.3 (2026-11-28)

Known issues: a path under a camelCase setting, like `authToken: /run/secrets/db_password`, gets a password warning,
as 0.1.2 does under `auth_token:`. A plain number after a login code and "and", like `the login code is 482913 and
551234.`, gets a warning of its own.

- Engine 1.6.4 finds passwords under camelCase names like `dbPassword:` in YAML, JSON and XML, tokens in 19 more
  formats, secret webhook links, and a password in a link like `ssh://deploy:wibble99@files.wibblecorp.io`.
- Fewer false alarms on stand-in keys and passwords, a key block of only `...`, a key file's path like
  `apiKey: ./certs/server.pem`, a setting in backticks like `secret: true` and an order number shaped like a card.
- Check my clipboard and Check selection show less of a found value. A password or private key shows only dots, and a
  made-up AWS key that 0.1.2 showed as `AKIA…3N` shows as `AK…3N`.
- When one of those checks runs out of time, Copy a cleaned version checks the rest of the text first, and copies
  nothing if it can't finish. 0.1.2 copied the unchecked part as it was.
- A file of thousands of blank lines is checked in under half a second. 0.1.2 took 22 to 91 seconds and stopped partway.
- The icon's corner mark is the same steel disc as the VS Code extension's. The source is now readable files grouped by
  what they do, and nothing about how the plugin works for you changes.

## 0.1.2 (2026-11-08)

- The plugin marks a file or clipboard check that stops early as incomplete, so unchecked text no longer counts as clean.
- Medical record, Medicare, driver's license and insurance member numbers, your own IP address and gamer tags now wait
  for the personal details setting, like other personal details. 0.1.1 warned on them with that setting off. Card,
  card security code, gift card and bank numbers still warn by default.
- Each copy of a repeated credential gets its own warning and quick fix. A copy inside a longer word or number, like a
  PIN inside an order number, doesn't get one.
- The status bar counts only files open in an editor. Ignore checks read parent `.gitignore` files, repository excludes and the global ignore file.
- Guard setup works on the project in the current IDE window and explains which assistants changed when setup fails.
- The skip-pattern list scrolls, Spanish messages match English, and the 1.6.1 engine finds more national IDs, access tokens and wrapped credentials.

## 0.1.1 (2026-10-27)

- Git ignore checks use bounded matching. Add to `.gitignore` escapes paths and refuses links or non-regular files.
- Plugin builds and the IDE sandbox stay under the project's `build/` directory.
- Clotr now catches access tokens from Open VSX, RubyGems and JetBrains Marketplace.
- Changing Clotr's settings rechecks files that are already open, so their warnings and the status bar count follow
  the new settings right away.
