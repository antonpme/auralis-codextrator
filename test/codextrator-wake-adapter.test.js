"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const store = require("../src/store.js");

const repoRoot = path.resolve(__dirname, "..");
const wakeCli = path.join(repoRoot, "bin", "codextrator-wake-adapter.js");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codextrator-wake-adapter-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-01");

function runWakeAdapter(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [wakeCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, status: 0, stdout, data: JSON.parse(stdout) };
  } catch (error) {
    if (options.allowFailure) {
      const stdout = error.stdout ? error.stdout.toString() : "";
      return {
        ok: false,
        status: error.status,
        stdout,
        data: stdout ? JSON.parse(stdout) : null
      };
    }
    throw error;
  }
}

try {
  fs.mkdirSync(worktree, { recursive: true });
  const storeDir = store.ensureStore(workspaceRoot, "coordinator");
  store.registerSlot(storeDir, {
    slot: "session-01",
    project: "demo-project",
    identity: "elian",
    focus: "Wake adapter proof",
    worktree,
    branch: "codex/wake-adapter"
  });
  store.recordHeartbeat(storeDir, {
    slot: "session-01",
    status: "ok",
    run_id: "wake-adapter-test-run"
  });
  store.createTask(storeDir, {
    slot: "session-01",
    task_id: "wake-adapter-task-1",
    title: "Wake adapter task",
    message: "Claim this through MCP."
  });

  let result = runWakeAdapter([
    "--root",
    workspaceRoot,
    "--json",
    "--send",
    "--heartbeat-max-minutes",
    "60"
  ], { allowFailure: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.data.ok, false);
  assert.strictEqual(result.data.summary.blocked, 1);
  assert.strictEqual(result.data.attempts[0].slot, "session-01");
  assert.strictEqual(result.data.attempts[0].status, "blocked");
  assert.strictEqual(result.data.attempts[0].reason, "missing_app_server_thread_id");

  const wakeFilesAfterBlocked = fs.readdirSync(path.join(workspaceRoot, ".auralis-codextrator", "wake"));
  assert.strictEqual(wakeFilesAfterBlocked.length, 1);

  store.registerSlot(storeDir, {
    slot: "session-01",
    project: "demo-project",
    identity: "elian",
    focus: "Wake adapter proof",
    worktree,
    branch: "codex/wake-adapter",
    app_server_thread_id: "019e-test-thread"
  });

  result = runWakeAdapter([
    "--root",
    workspaceRoot,
    "--json",
    "--dry-run",
    "--heartbeat-max-minutes",
    "60"
  ]);
  assert.strictEqual(result.data.ok, true);
  assert.strictEqual(result.data.send, false);
  assert.strictEqual(result.data.summary.planned, 1);
  assert.strictEqual(result.data.actions[0].adapter_request.mode, "ready");
  assert.strictEqual(result.data.actions[0].adapter_request.params.threadId, "019e-test-thread");

  const wakeFilesAfterDryRun = fs.readdirSync(path.join(workspaceRoot, ".auralis-codextrator", "wake"));
  assert.strictEqual(wakeFilesAfterDryRun.length, 1);

  console.log("codextrator-wake-adapter.test.js: PASS");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
