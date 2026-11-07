# Changelog

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
