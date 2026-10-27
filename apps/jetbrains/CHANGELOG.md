# Changelog

## Unreleased

- Git ignore checks use bounded matching. Add to `.gitignore` escapes paths and refuses links or non-regular files.
- Plugin builds and the IDE sandbox stay under the project's `build/` directory.
- Clotr now catches access tokens from Open VSX, RubyGems and JetBrains Marketplace.
- Changing Clotr's settings rechecks files that are already open, so their warnings and the status bar count follow
  the new settings right away.
