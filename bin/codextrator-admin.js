#!/usr/bin/env node
"use strict";

const { createAdminServer, DEFAULT_HOST, DEFAULT_PORT } = require("../src/admin-server.js");

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }

  const host = opts.host || DEFAULT_HOST;
  const port = Number(opts.port || DEFAULT_PORT);
  const server = createAdminServer({
    root: opts.root,
    agent: opts.agent,
    host,
    port,
    heartbeatMaxMinutes: opts["heartbeat-max-minutes"],
    pollMs: opts["poll-ms"]
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = address && address.port ? address.port : port;
    console.log(`Auralis Codextrator Admin: http://${host}:${actualPort}`);
    console.log(`Store: ${server.storeDir}`);
    console.log("Mode: read-only dashboard");
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`codextrator-admin

Usage:
  codextrator-admin [--root PATH] [--host 127.0.0.1] [--port 8787]
                    [--heartbeat-max-minutes N] [--poll-ms N]

Starts a local read-only browser dashboard for the Codextrator Focus Board,
slot registry, task pool, and wake-plan state.
`);
}

main();
