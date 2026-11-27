"use strict";

const fs = require("fs");

// Counts every disk lookup the check makes while `fn` runs. With `tick`, a made-up clock stands still but for a
// millisecond per lookup, so a deadline is reached after a known number of lookups, however fast or busy the computer
// is. With `still`, the clock doesn't move at all, so no deadline is reached and only the lookups are measured.
function countingLookups(fn, { tick = false, still = false } = {}) {
  const names = ["lstatSync", "statSync", "realpathSync", "readdirSync", "existsSync", "opendirSync", "accessSync"];
  const originals = names.map((name) => [name, fs[name], fs[name].native]);
  const realNow = Date.now;
  const started = realNow();
  let lookups = 0;
  const byName = {};
  const count = (name) => {
    lookups += 1;
    byName[name] = (byName[name] || 0) + 1;
  };
  for (const [name, original, native] of originals) {
    fs[name] = function (...args) {
      count(name);
      return original.apply(this, args);
    };
    if (native) {
      fs[name].native = function (...args) {
        count(`${name}.native`);
        return native.apply(this, args);
      };
    }
  }
  if (tick) Date.now = () => started + lookups;
  if (still) Date.now = () => started;
  try {
    const result = fn();
    return { result, lookups, byName };
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    Date.now = realNow;
  }
}

module.exports = { countingLookups };
