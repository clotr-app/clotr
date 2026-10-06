// Finds the browser suite's sections by reading file names out of ./checks, so a new area can run without anyone
// editing a list in run.js. Sections run in number order and share one browser, so a later one can build on what an
// earlier one set up. The two sections that only do something with --stress or --store always run last.
"use strict";

const fs = require("fs");
const path = require("path");

const LAST = ["16-stress", "17-store-screenshots"];

// These sections exercise a held-back feature's own doors: Tourniquet, Command check, "Is this a scam?", Practice,
// Office training, Look back, and Extension check. The default build hides all of those doors, so the sections only
// make sense against an all-on build (npm run test:e2e:all-on, --all-on). Every other section keeps testing the
// default build, where none of those doors exist.
const FEATURE_ONLY = [
  "21-tourniquet",
  "23-command-check",
  "24-scam-check",
  "25-practice",
  "26-scam-shield",
  "27-training",
  "31-look-back",
  "32-extension-check",
  "33-popup-doors",
];

function sections(dir = path.join(__dirname, "checks"), allOn = false) {
  const found = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-[\w-]+\.js$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
  const picked = allOn ? found.filter((s) => FEATURE_ONLY.includes(s)) : found.filter((s) => !FEATURE_ONLY.includes(s));
  return [...picked.filter((s) => !LAST.includes(s)), ...LAST.filter((s) => picked.includes(s))];
}

module.exports = { sections, FEATURE_ONLY };
