#!/usr/bin/env node
"use strict";

const path = require("path");
const store = require("../src/store.js");
const { defaultSessionsRoot, discoverAppThreads } = require("../src/app-thread-discovery.js");

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }

  const root = path.resolve(opts.root || process.env.AURALIS_CODENATOR_ROOT || process.env.AURALIS_CODEXTRATOR_ROOT || process.cwd());
  const storeDir = store.ensureStore(root, opts.agent || "app-thread-discovery");
  const slots = parseSlots(opts.slots);
  const discovered = discoverAppThreads({
    sessionsRoot: opts["sessions-root"] || defaultSessionsRoot(),
    limit: opts.limit
  });
  const proposals = discovered.proposals
    .filter((proposal) => slots.size === 0 || slots.has(proposal.slot));
  const result = {
    ok: true,
    root,
    sessions_root: discovered.sessions_root,
    scanned_files: discovered.scanned_files,
    apply: truthy(opts.apply),
    proposals,
    applied: [],
    skipped: []
  };

  if (truthy(opts.apply)) {
    for (const proposal of proposals) {
      if (proposal.slot === "coordinator") {
        result.skipped.push({
          slot: proposal.slot,
          thread_id: proposal.thread_id,
          reason: "coordinator_registration_not_supported"
        });
        continue;
      }
      const registered = store.registerSlot(storeDir, {
        slot: proposal.slot,
        project: opts.project || "",
        identity: opts.identity || "",
        focus: proposal.title || proposal.slot,
        worktree: proposal.worktree || proposal.cwd || root,
        branch: opts.branch || "",
        app_server_thread_id: proposal.thread_id,
        app_server_url: opts.url || ""
      });
      result.applied.push({
        slot: registered.slot,
        app_server_thread_id: registered.app_server_thread_id,
        app_server_url: registered.app_server_url,
        file: proposal.file
      });
    }
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

function parseSlots(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean));
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
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

function printHuman(result) {
  console.log(`Codenator app thread discovery: ${result.proposals.length} proposal(s)`);
  console.log(`sessions=${result.sessions_root}`);
  for (const proposal of result.proposals) {
    console.log(`${proposal.slot.padEnd(12)} ${proposal.thread_id} ${proposal.confidence} ${proposal.title}`);
  }
  if (result.apply) {
    console.log(`applied=${result.applied.length} skipped=${result.skipped.length}`);
  }
}

function printHelp() {
  console.log(`codenator-app-thread-discover

Usage:
  codenator-app-thread-discover [--root PATH] [--sessions-root PATH] [--json]
                                  [--slots session-01,session-02] [--apply]
                                  [--url ws://127.0.0.1:4575]

Legacy alias:
  codextrator-app-thread-discover [--root PATH] [--sessions-root PATH] [--json]
                                  [--slots session-01,session-02] [--apply]
                                  [--url ws://127.0.0.1:4575]

Scans Codex Desktop session JSONL files for explicit AOS/Codenator slot
prompts and proposes app-server thread ids. Default mode is read-only. With
--apply, writes app_server_thread_id metadata for non-coordinator slots only.
`);
}

main();
