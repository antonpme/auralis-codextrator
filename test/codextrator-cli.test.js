"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "bin", "codextrator.js");
const tmpRoot = path.join(repoRoot, ".tmp-test", `run-${Date.now()}`);
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-01");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCodextrator(args, options = {}) {
  return run(process.execPath, [cli, ...args], options);
}

function readStatus(cwd = workspaceRoot) {
  return JSON.parse(runCodextrator(["status", "--json"], { cwd }));
}

function sessionRow(status, slot) {
  return status.rows.find((row) => row.slot === slot);
}

function cleanup() {
  if (!tmpRoot.startsWith(path.join(repoRoot, ".tmp-test"))) {
    throw new Error(`Refusing to clean unexpected path: ${tmpRoot}`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

try {
  cleanup();
  fs.mkdirSync(worktree, { recursive: true });

  runCodextrator(["init", "--root", workspaceRoot], { cwd: workspaceRoot });
  runCodextrator([
    "register",
    "session-01",
    "--project",
    "demo-project",
    "--identity",
    "elian",
    "--focus",
    "Memory Slice",
    "--worktree",
    worktree,
    "--branch",
    "codex/demo"
  ], { cwd: workspaceRoot });

  let status = readStatus();
  assert.strictEqual(sessionRow(status, "session-01").unread, 0);

  runCodextrator([
    "send",
    "session-01",
    "--from",
    "coordinator",
    "--subject",
    "Round 1",
    "--message",
    "Do the focused task."
  ], { cwd: workspaceRoot });

  status = readStatus();
  assert.strictEqual(sessionRow(status, "session-01").unread, 1);

  const peeked = JSON.parse(runCodextrator(["inbox", "session-01", "--json", "--peek"], { cwd: workspaceRoot }));
  assert.strictEqual(peeked.length, 1);
  assert.strictEqual(peeked[0].subject, "Round 1");
  status = readStatus();
  assert.strictEqual(sessionRow(status, "session-01").unread, 1);

  const read = JSON.parse(runCodextrator(["inbox", "session-01", "--json"], { cwd: workspaceRoot }));
  assert.strictEqual(read.length, 1);
  status = readStatus();
  assert.strictEqual(sessionRow(status, "session-01").unread, 0);

  run("git", ["init"], { cwd: worktree });
  run("git", ["config", "user.email", "codextrator-test@example.invalid"], { cwd: worktree });
  run("git", ["config", "user.name", "Codextrator Test"], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, "README.md"), "# Demo\n", "utf8");
  run("git", ["add", "README.md"], { cwd: worktree });
  run("git", ["commit", "-m", "feat: demo commit"], { cwd: worktree });

  const env = { AURALIS_CODEXTRATOR_ROOT: workspaceRoot };
  const reportOutput = runCodextrator(["report-commit", "--slot", "session-01"], { cwd: worktree, env });
  assert.match(reportOutput, /Reported commit/);

  status = readStatus();
  assert.strictEqual(sessionRow(status, "coordinator").unread, 1);

  const duplicateOutput = runCodextrator(["report-commit", "--slot", "session-01"], { cwd: worktree, env });
  assert.match(duplicateOutput, /already reported/);
  status = readStatus();
  assert.strictEqual(sessionRow(status, "coordinator").unread, 1);

  const coordinatorInbox = JSON.parse(runCodextrator(["inbox", "coordinator", "--json"], { cwd: workspaceRoot }));
  assert.strictEqual(coordinatorInbox.length, 1);
  assert.strictEqual(coordinatorInbox[0].type, "commit_report");
  status = readStatus();
  assert.strictEqual(sessionRow(status, "coordinator").unread, 0);

  console.log("codextrator-cli.test.js: PASS");
} finally {
  cleanup();
}
