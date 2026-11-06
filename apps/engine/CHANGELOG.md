# Clotr engine

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
