"use strict";

/* global Buffer, process, require */

const crypto = require("node:crypto");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
const { corpora, findings } = require(path.join(root, "tools", "engine-parity.js"));
const sets = corpora({ size: 400 }).filter((set) => set.check === "detect");

for (const set of sets) {
  for (const item of set.items) {
    const hits = findings("detect", item)
      .filter((hit) => Number.isInteger(hit.start) && hit.value !== undefined)
      .map((hit) => {
        const digest = crypto.createHash("sha256").update(hit.value, "utf8").digest("hex");
        return `${hit.kind},${hit.severity},${hit.start},${hit.end},${digest}`;
      });
    process.stdout.write(
      `${set.id}\t${item.id}\t${Buffer.from(item.text, "utf8").toString("base64")}\t${hits.join(";")}\n`,
    );
  }
}
