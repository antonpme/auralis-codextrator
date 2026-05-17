#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const STORE_NAME = ".auralis-codextrator";

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const { args, opts } = parseArgs(argv.slice(1));

  try {
    switch (command) {
      case "init":
        cmdInit(opts);
        break;
      case "register":
        cmdRegister(args, opts);
        break;
      case "send":
        cmdSend(args, opts);
        break;
      case "inbox":
        cmdInbox(args, opts);
        break;
      case "status":
        cmdStatus(opts);
        break;
      case "report-commit":
        cmdReportCommit(opts);
        break;
      case "hook-post-tool-use":
        cmdHookPostToolUse();
        break;
      case "hook-template":
        cmdHookTemplate();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`codextrator: ${error.message}`);
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`auralis-codextrator

Usage:
  codextrator init [--root PATH]
  codextrator register SLOT --project NAME --focus TEXT --worktree PATH [--branch BRANCH] [--identity NAME]
  codextrator send TO --from SLOT --message TEXT [--subject TEXT]
  codextrator inbox SLOT [--peek] [--json]
  codextrator status [--json]
  codextrator report-commit [--slot SLOT] [--force]
  codextrator hook-post-tool-use
  codextrator hook-template
`);
}

function parseArgs(argv) {
  const args = [];
  const opts = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }

  return { args, opts };
}

function cmdInit(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const store = path.join(root, STORE_NAME);
  ensureStore(store);
  const registryPath = path.join(store, "registry.json");

  if (!fs.existsSync(registryPath)) {
    writeJson(registryPath, {
      version: 1,
      name: "auralis-codextrator",
      created_at: now(),
      updated_at: now(),
      coordinator: {
        slot: "coordinator",
        identity: "coordinator",
        status: "active"
      },
      sessions: {}
    });
  }

  ensureInbox(store, "coordinator");
  console.log(`Initialized ${store}`);
}

function cmdRegister(args, opts) {
  const slot = args[0];
  if (!slot) throw new Error("register requires SLOT");
  if (!opts.project) throw new Error("register requires --project");
  if (!opts.focus) throw new Error("register requires --focus");
  if (!opts.worktree) throw new Error("register requires --worktree");

  const store = findStore();
  const registry = readRegistry(store);
  const worktree = normalizePath(opts.worktree);
  const branch = opts.branch || detectGitBranch(worktree) || "";

  registry.sessions[slot] = {
    slot,
    identity: opts.identity || "developer",
    project: opts.project,
    focus: opts.focus,
    worktree,
    branch,
    status: opts.status || "active",
    inbox: `inbox/${slot}`,
    updated_at: now()
  };
  registry.updated_at = now();

  writeRegistry(store, registry);
  ensureInbox(store, slot);
  console.log(`Registered ${slot}: ${opts.project} / ${opts.focus}`);
}

function cmdSend(args, opts) {
  const to = args[0];
  if (!to) throw new Error("send requires TO");
  const store = findStore();
  const from = opts.from || inferSlot(store) || "unknown";
  const message = opts.message || readStdinIfAvailable();
  if (!message.trim()) throw new Error("send requires --message or stdin");

  const payload = {
    id: makeId(),
    type: opts.type || "message",
    from,
    to,
    subject: opts.subject || "",
    message,
    created_at: now(),
    cwd: normalizePath(process.cwd())
  };

  writeMessage(store, to, payload);
  console.log(`Sent ${payload.id} to ${to}`);
}

function cmdInbox(args, opts) {
  const slot = args[0] || "coordinator";
  const store = findStore();
  ensureInbox(store, slot);
  const dir = path.join(store, "inbox", slot);
  const files = listJsonFiles(dir);
  const messages = files.map((file) => readJson(path.join(dir, file)));

  if (opts.json) {
    console.log(JSON.stringify(messages, null, 2));
  } else if (messages.length === 0) {
    console.log(`Inbox ${slot}: empty`);
  } else {
    console.log(`Inbox ${slot}: ${messages.length} message(s)`);
    for (const message of messages) {
      console.log("");
      console.log(`[${message.created_at}] ${message.from} -> ${message.to}`);
      if (message.subject) console.log(`Subject: ${message.subject}`);
      console.log(message.message);
    }
  }

  if (!opts.peek) {
    const archiveDir = path.join(store, "archive", slot);
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const file of files) {
      fs.renameSync(path.join(dir, file), path.join(archiveDir, file));
    }
  }
}

function cmdStatus(opts) {
  const store = findStore();
  const registry = readRegistry(store);
  const slots = ["coordinator", ...Object.keys(registry.sessions).sort()];
  const rows = slots.map((slot) => {
    const session = slot === "coordinator" ? registry.coordinator : registry.sessions[slot];
    return {
      slot,
      identity: session.identity || "",
      project: session.project || "",
      focus: session.focus || "",
      branch: session.branch || "",
      status: session.status || "",
      unread: countInbox(store, slot)
    };
  });

  if (opts.json) {
    console.log(JSON.stringify({ registry, rows }, null, 2));
    return;
  }

  console.log("Auralis Codextrator status");
  for (const row of rows) {
    console.log(
      `${row.slot.padEnd(12)} unread=${String(row.unread).padEnd(2)} ` +
      `${row.project.padEnd(12)} ${row.branch.padEnd(34)} ${row.focus}`
    );
  }
}

function cmdReportCommit(opts) {
  const store = findStore();
  const slot = opts.slot || inferSlot(store);
  if (!slot) throw new Error("Could not infer session slot. Pass --slot.");

  const sha = git(["rev-parse", "HEAD"], process.cwd()).trim();
  const branch = git(["branch", "--show-current"], process.cwd()).trim();
  const subject = git(["log", "-1", "--pretty=%s"], process.cwd()).trim();
  const body = git(["log", "-1", "--pretty=%b"], process.cwd()).trim();
  const changed = git(["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"], process.cwd())
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  if (!opts.force && alreadyReported(store, slot, sha)) {
    console.log(`Commit ${sha.slice(0, 7)} already reported for ${slot}`);
    return;
  }

  const report = {
    id: makeId(),
    type: "commit_report",
    slot,
    sha,
    branch,
    subject,
    body,
    changed,
    worktree: normalizePath(process.cwd()),
    created_at: now()
  };

  const reportPath = path.join(store, "reports", `${safeStamp()}_${slot}_${sha.slice(0, 12)}.json`);
  writeJson(reportPath, report);
  markReported(store, slot, sha);

  writeMessage(store, "coordinator", {
    id: makeId(),
    type: "commit_report",
    from: slot,
    to: "coordinator",
    subject: `Commit ${sha.slice(0, 7)}: ${subject}`,
    message: renderCommitReport(report),
    report_ref: normalizePath(reportPath),
    created_at: now(),
    cwd: normalizePath(process.cwd())
  });

  console.log(`Reported commit ${sha.slice(0, 7)} from ${slot}`);
}

function cmdHookPostToolUse() {
  const input = readStdinIfAvailable();
  if (!input.trim()) return;

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }

  const text = JSON.stringify(event);
  const isPostToolUse = event.hook_event_name === "PostToolUse" || text.includes("PostToolUse");
  const looksLikeGitCommit = /\bgit\s+commit\b/i.test(text);
  if (!isPostToolUse || !looksLikeGitCommit) return;

  try {
    cmdReportCommit({});
  } catch (error) {
    // Hooks should not break the user turn. Persist a best-effort error.
    try {
      const store = findStore();
      const errorPath = path.join(store, "reports", `${safeStamp()}_hook_error.json`);
      writeJson(errorPath, {
        id: makeId(),
        type: "hook_error",
        message: error.message,
        created_at: now()
      });
    } catch {
      // ignore
    }
  }
}

function cmdHookTemplate() {
  const cliPath = normalizePath(__filename);
  const command = `node "${cliPath}" hook-post-tool-use`;
  const template = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash|shell_command|functions.shell_command",
          hooks: [
            {
              type: "command",
              command
            }
          ]
        }
      ]
    }
  };

  console.log(JSON.stringify(template, null, 2));
}

function ensureStore(store) {
  fs.mkdirSync(store, { recursive: true });
  for (const name of ["inbox", "archive", "reports", "tasks", "hooks"]) {
    fs.mkdirSync(path.join(store, name), { recursive: true });
  }
}

function ensureInbox(store, slot) {
  fs.mkdirSync(path.join(store, "inbox", slot), { recursive: true });
  fs.mkdirSync(path.join(store, "archive", slot), { recursive: true });
}

function findStore() {
  const envRoot = process.env.AURALIS_CODEXTRATOR_ROOT;
  if (envRoot) {
    const store = path.join(path.resolve(envRoot), STORE_NAME);
    if (fs.existsSync(store)) return store;
  }

  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, STORE_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not find ${STORE_NAME}. Run init first or set AURALIS_CODEXTRATOR_ROOT.`);
}

function readRegistry(store) {
  const registryPath = path.join(store, "registry.json");
  if (!fs.existsSync(registryPath)) throw new Error("registry.json is missing. Run init first.");
  return readJson(registryPath);
}

function writeRegistry(store, registry) {
  writeJson(path.join(store, "registry.json"), registry);
}

function inferSlot(store) {
  const registry = readRegistry(store);
  const cwd = normalizePath(process.cwd()).toLowerCase();

  for (const [slot, session] of Object.entries(registry.sessions || {})) {
    const worktree = normalizePath(session.worktree || "").toLowerCase();
    if (worktree && (cwd === worktree || cwd.startsWith(`${worktree}/`))) {
      return slot;
    }
  }

  return null;
}

function detectGitBranch(cwd) {
  try {
    return git(["branch", "--show-current"], cwd).trim();
  } catch {
    return "";
  }
}

function writeMessage(store, to, payload) {
  ensureInbox(store, to);
  const file = `${safeStamp()}_${payload.id}.json`;
  writeJson(path.join(store, "inbox", to, file), payload);
}

function renderCommitReport(report) {
  const changed = report.changed.length ? report.changed.map((item) => `- ${item}`).join("\n") : "- No files listed";
  return [
    `Slot: ${report.slot}`,
    `Branch: ${report.branch}`,
    `Commit: ${report.sha}`,
    `Subject: ${report.subject}`,
    "",
    "Changed files:",
    changed,
    "",
    `Report created: ${report.created_at}`
  ].join("\n");
}

function alreadyReported(store, slot, sha) {
  const file = path.join(store, "reports", "last-reported.json");
  if (!fs.existsSync(file)) return false;
  const data = readJson(file);
  return data[slot] === sha;
}

function markReported(store, slot, sha) {
  const file = path.join(store, "reports", "last-reported.json");
  const data = fs.existsSync(file) ? readJson(file) : {};
  data[slot] = sha;
  writeJson(file, data);
}

function countInbox(store, slot) {
  const dir = path.join(store, "inbox", slot);
  if (!fs.existsSync(dir)) return 0;
  return listJsonFiles(dir).length;
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readStdinIfAvailable() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function safeStamp() {
  return now().replace(/[:.]/g, "-");
}

function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, "/");
}

main();
