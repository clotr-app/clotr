"use strict";

function pruneIgnoredOnce(ignored, active) {
  if (!ignored) return 0;
  let removed = 0;
  for (const [occurrence, fingerprint] of ignored) {
    if (active.get(occurrence) === fingerprint) continue;
    ignored.delete(occurrence);
    removed += 1;
  }
  return removed;
}

module.exports = { pruneIgnoredOnce };
