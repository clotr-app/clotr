// report.md, 20 Oct 2026; seconds/shard: 01-protection=81.9/3 02-toolbar=14.9/3 03-popup-dashboard=43.5/2
// 04-scope=47.0/1 05-chat-styles=7.9/3 06-disguised-details=32.6/1 07-responses=381.5/2 08-vault=67.3/2
// 09-updates=36.6/2 10-privacy-health=198.0/2 11-report-and-map=409.0/1 12-first-time-tips=31.4/3
// 13-accessibility=60.4/1 14-fail-open=45.7/3 15-performance=68.1/3 18-bandage=193.6/3 19-report-button=40.1/3
// 20-everyday-sites=129.1/1 21-tourniquet=219.5/3 22-who-asks=171.1/3 23-command-check=34.5/3 24-scam-check=29.9/3
// 25-practice=45.4/1 26-scam-shield=163.0/2 28-truncated-warning=12.9/2 30-feature-gates=7.5/1 34-big-look=41.0/2
// 35-clean-link=43.2/1 36-email-quotes=49.0/2 42-search-support-sites=135.9/1 43-everywhere=53.1/1
// Totals: 963.2s, 992.8s and 938.6s; spread 54.2s.
"use strict";

const SHARDS = {
  1: [
    "04-scope",
    "06-disguised-details",
    "11-report-and-map",
    "13-accessibility",
    "20-everyday-sites",
    "30-feature-gates",
    "25-practice",
    "42-search-support-sites",
    "35-clean-link",
    "43-everywhere",
  ],
  2: [
    "03-popup-dashboard",
    "07-responses",
    "08-vault",
    "09-updates",
    "10-privacy-health",
    "34-big-look",
    "26-scam-shield",
    "28-truncated-warning",
    "36-email-quotes",
  ],
  3: [
    "01-protection",
    "02-toolbar",
    "05-chat-styles",
    "14-fail-open",
    "15-performance",
    "18-bandage",
    "19-report-button",
    "12-first-time-tips",
    "22-who-asks",
    "21-tourniquet",
    "23-command-check",
    "24-scam-check",
  ],
};

// Throw on unknown shard keys so a typo in CI fails loudly instead of skipping the suite.
function sectionsForShard(key) {
  const names = SHARDS[key];
  if (!names) throw new Error(`unknown shard "${key}" (known: ${Object.keys(SHARDS).join(", ")})`);
  return names;
}

module.exports = { SHARDS, sectionsForShard };
