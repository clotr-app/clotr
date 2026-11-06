# Glama builds Clotr MCP from this file. The version is the one in package.json, and tests/mcp.test.js checks it.
FROM node:22-slim
RUN npm install -g clotr-guard@0.1.2
USER node
CMD ["clotr-mcp"]
