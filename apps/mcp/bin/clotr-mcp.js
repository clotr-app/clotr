#!/usr/bin/env node
"use strict";
/* global require, module, process */

const server = require("../../guard/bin/clotr-mcp.js");

if (require.main === module) {
  if (process.argv[2] === "--print-config") server.printConfig(process.argv[3]);
  else server.serve();
}

module.exports = server;
