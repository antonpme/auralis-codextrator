#!/usr/bin/env node
"use strict";

const path = require("path");
const store = require("../src/store.js");

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }

  const root = path.resolve(opts.root || process.env.AURALIS_CODEXTRATOR_ROOT || process.cwd());
  const storeDir = store.ensureStore(root, opts.agent || "watcher");
  const plan = store.buildWakePlan(storeDir, {
    adapter: opts.adapter || "notify-only",
    heartbeat_max_minutes: opts["heartbeat-max-minutes"],
    checked_at: opts["checked-at"]
  });

  if (opts["record-dry-run"]) {
    plan.recorded_attempts = plan.actions
      .filter((action) => action.action === "wake_slot")
      .map((action) => store.recordWakeAttempt(storeDir, {
        slot: action.slot,
        action: action.action,
        adapter: plan.adapter,
        status: "planned",
        reason: action.reason,
        prompt: action.prompt
      }));
  }

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Codextrator MCP watch: ${plan.decision}`);
  console.log(`adapter=${plan.adapter} wake=${plan.summary.wake} notify=${plan.summary.notify} blocked=${plan.summary.blocked}`);
  for (const action of plan.actions) {
    if (action.action === "ok" || action.action === "idle_healthy") continue;
    console.log(`${action.slot.padEnd(12)} ${action.action.padEnd(26)} ${action.reason}`);
  }
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
  return { opts };
}

function printHelp() {
  console.log(`codextrator-mcp-watch

Usage:
  codextrator-mcp-watch [--root PATH] [--json] [--adapter notify-only|codex-app-server]
                        [--heartbeat-max-minutes N] [--record-dry-run]

Reads the MCP ledger store and prints a non-mutating wake plan. With
--record-dry-run, writes wake attempt audit records only; it still does not
claim tasks, clear inboxes, or start Codex sessions.
`);
}

main();
