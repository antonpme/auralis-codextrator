#!/usr/bin/env node
"use strict";

const path = require("path");
const { startPersistentThread } = require("../src/app-server-client.js");

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }

  const prompt = opts.prompt || (opts.slot
    ? `Auralis Codextrator headless slot ${opts.slot}. Reply exactly: READY_${opts.slot.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}.`
    : "");
  const expected = opts.expected || (opts.slot
    ? `READY_${opts.slot.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    : "");

  startPersistentThread({
    port: opts.port,
    url: opts.url,
    cwd: opts.cwd || opts["server-cwd"],
    threadCwd: opts["thread-cwd"] || opts.cwd,
    prompt,
    expected,
    baseInstructions: opts["base-instructions"],
    approvalPolicy: opts["approval-policy"] || "never",
    sandbox: opts.sandbox || "workspace-write",
    effort: opts.effort || "low",
    timeoutMs: opts["timeout-ms"] || 120000,
    interruptOnTimeout: opts["interrupt-on-timeout"] !== "false"
  }).then((result) => {
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    const result = {
      ok: false,
      reason: "app_thread_start_error",
      error: error.stack || error.message
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`codextrator-app-thread-start: ${error.message}`);
    process.exitCode = 1;
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
  if (opts.cwd) opts.cwd = path.resolve(opts.cwd);
  if (opts["thread-cwd"]) opts["thread-cwd"] = path.resolve(opts["thread-cwd"]);
  if (opts["server-cwd"]) opts["server-cwd"] = path.resolve(opts["server-cwd"]);
  return opts;
}

function printHuman(result) {
  console.log(`Codextrator app-thread start: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`reason=${result.reason}`);
  if (result.thread_id) console.log(`thread=${result.thread_id}`);
  const evidence = result.evidence || {};
  if (evidence.turn_id) console.log(`turn=${evidence.turn_id}`);
  if (evidence.agent_text) console.log(`agent=${evidence.agent_text}`);
  if (evidence.error) console.log(`error=${evidence.error}`);
}

function printHelp() {
  console.log(`codextrator-app-thread-start

Usage:
  codextrator-app-thread-start --slot session-01 --cwd PATH [--json]
  codextrator-app-thread-start --cwd PATH --prompt TEXT --expected TEXT [--json]

Starts a persistent Codex app-server thread for a headless Codextrator focus
slot, sends an optional readiness prompt, waits for turn completion, and prints
the thread id. This command does not register the slot; use register_slot or
codextrator-app-thread-discover to persist the thread id in the ledger.
`);
}

main();
