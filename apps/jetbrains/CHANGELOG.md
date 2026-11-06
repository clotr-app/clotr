# Changelog

## Unreleased

- A file Clotr ran out of time on gets a note at the top and counts as not checked in the status bar, and Check my
  clipboard and the selection check say part of the text wasn't checked, instead of reporting it clean.
- With personal-detail checks off, the default, every kind the engine groups as personal stays off, including card
  numbers, bank accounts, medical records and licences, which a guess on the kind's name used to miss. Clotr Guard,
  which the plugin sets up for your assistant, still checks card, card security, gift-card and bank account numbers
  with personal details off.
- Every copy of a repeated credential in a file is highlighted, each with its quick fix.
- The status bar counts only files open in an editor, so Inspect Code and the checks before a commit no longer leave
  it wrong until the project is reopened.
- The Guard button in Settings acts on the project in its own window and names it, instead of the first open project.
- Git ignore checks follow Git's rules: a rule with a slash matches only from its own `.gitignore` folder, and
  `.gitignore` files above the project, the repository's `info/exclude` and the global ignore file are read too.
- When setting up Guard fails, the error names the assistant it failed on, the ones already updated and the ones left
  unchanged.
- The Spanish messages match the English ones, so no `{1}` shows and no message falls back to English.
- In Settings, the "File patterns to skip" label sits right above its list, which scrolls instead of growing the page.

## 0.1.1 (2026-10-27)

- Git ignore checks use bounded matching. Add to `.gitignore` escapes paths and refuses links or non-regular files.
- Plugin builds and the IDE sandbox stay under the project's `build/` directory.
- Clotr now catches access tokens from Open VSX, RubyGems and JetBrains Marketplace.
- Changing Clotr's settings rechecks files that are already open, so their warnings and the status bar count follow
  the new settings right away.
