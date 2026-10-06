# Versioning

Clotr's versions have three numbers, MAJOR.MINOR.PATCH, and every place that shows one shows the same one:

- the release on GitHub and its tag;
- the code on `main`;
- the Chrome Web Store, Edge Add-ons and Firefox Add-ons.

| Release | Example | What goes in it |
|---|---|---|
| **Minor** | 1.1 → **1.2.0** | New features or changes you'll notice. Most releases are minor. |
| **Patch** | 1.2.0 → **1.2.1** | Fixes only: bugs, false alarms, missed details, a site that changed under Clotr, security fixes. |
| **Major** | 1.x → **2.0.0** | A new generation of Clotr: a big change in what it is or how it works. Rare. |

## How a release is made

- A regular release comes out at most every two weeks, counted from 1.2.0 on, though an urgent fix for a security
  problem, a leak or a chat Clotr breaks can come out at any time, as a patch. Launch week moved faster while all
  three stores caught up, so 1.1.1, 1.1.2 and 1.2.0 came out within a week.
- Every release has:
  - a `vX.Y.Z` tag;
  - a GitHub release with the packages and their SHA-256 checksums;
  - a section in [CHANGELOG.md](CHANGELOG.md) with the same number and its date;
  - the same version sent to all three stores on the same day.
- A store can show the previous version for a few days while it reviews the new one.
- Stores show the version exactly as written here (1.2.0), never a build number.

## Builds between releases

Development builds add a fourth number (1.2.0.3), so testers can tell one build from the next. They are never tagged,
published or sent to a store; their notes collect under "Unreleased" at the top of the changelog until the release.
