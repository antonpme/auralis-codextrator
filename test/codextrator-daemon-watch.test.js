"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const store = require("../src/store.js");
const { runDaemonWatchOnce } = require("../src/daemon-watch.js");

const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "bin", "codextrator-daemon-watch.js");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codextrator-daemon-watch-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-04");

function setupSlot(input = {}) {
  const storeDir = store.ensureStore(workspaceRoot, "coordinator");
  store.registerSlot(storeDir, {
    slot: input.slot || "session-04",
    project: "demo-project",
    identity: "worker-a",
    focus: "Daemon watch proof",
    worktree,
    branch: "codex/daemon-watch",
    app_server_thread_id: input.threadId
  });
  store.recordHeartbeat(storeDir, {
    slot: input.slot || "session-04",
    status: "ok",
    run_id: "daemon-watch-test-run"
  });
  store.appendLedger(storeDir, {
    type: "wake.proof",
    from: "coordinator",
    to: input.slot || "session-04",
    subject: "Wake proof",
    message: "Harmless wake proof."
  });
  return storeDir;
}

function setupActiveSlot(input = {}) {
  const storeDir = store.ensureStore(workspaceRoot, "coordinator");
  const slot = input.slot || "session-04";
  store.registerSlot(storeDir, {
    slot,
    project: "demo-project",
    identity: "worker-a",
    focus: "Daemon watch active task proof",
    worktree,
    branch: "codex/daemon-watch",
    app_server_thread_id: input.threadId
  });
  store.recordHeartbeat(storeDir, {
    slot,
    status: "ok",
    run_id: "daemon-watch-active-task-run"
  });
  store.createTask(storeDir, {
    slot,
    task_id: `${slot}-active-task`,
    title: "Continue me",
    message: "Active task continuation proof."
  });
  store.claimNextTask(storeDir, slot);
  return storeDir;
}

function wakeFiles(storeDir) {
  return fs.readdirSync(path.join(storeDir, "wake"));
}

try {
  fs.mkdirSync(worktree, { recursive: true });

  let storeDir = setupSlot({ threadId: "thread-session-04" });
  let result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: false,
    heartbeatMaxMinutes: 60
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.planned, 1);
  assert.strictEqual(result.summary.sent, 0);
  assert.strictEqual(result.attempts.length, 0);
  assert.strictEqual(store.buildStatus(storeDir).slots.find((slot) => slot.slot === "session-04").unread, 1);

  result = JSON.parse(execFileSync(process.execPath, [
    cli,
    "--root",
    workspaceRoot,
    "--json",
    "--once",
    "--heartbeat-max-minutes",
    "60"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }));
  assert.strictEqual(result.cycles.length, 1);
  assert.strictEqual(result.cycles[0].summary.planned, 1);
  assert.strictEqual(wakeFiles(storeDir).length, 0);

  fs.rmSync(path.join(workspaceRoot, ".auralis-codextrator"), { recursive: true, force: true });
  storeDir = setupSlot({ threadId: "" });
  result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: true,
    heartbeatMaxMinutes: 60
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.summary.blocked, 1);
  assert.strictEqual(result.attempts[0].status, "blocked");
  assert.strictEqual(result.attempts[0].reason, "missing_app_server_thread_id");
  assert.strictEqual(wakeFiles(storeDir).length, 1);

  fs.rmSync(path.join(workspaceRoot, ".auralis-codextrator"), { recursive: true, force: true });
  storeDir = setupSlot({ threadId: "thread-session-04" });
  result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: true,
    heartbeatMaxMinutes: 60,
    sendTurnToThread: () => {
      throw new Error("sendTurnToThread must not be called without prompt or promptMode=work");
    }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.summary.blocked, 1);
  assert.strictEqual(result.attempts[0].status, "blocked");
  assert.strictEqual(result.attempts[0].reason, "explicit_prompt_mode_required");
  assert.strictEqual(wakeFiles(storeDir).length, 1);

  fs.rmSync(path.join(workspaceRoot, ".auralis-codextrator"), { recursive: true, force: true });
  storeDir = setupSlot({ threadId: "thread-session-04" });
  result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: true,
    heartbeatMaxMinutes: 60,
    prompt: "Harmless injected proof prompt.",
    sendTurnToThread: (input) => ({
      ok: true,
      reason: "fake_completed",
      evidence: {
        thread_id: input.threadId,
        turn_id: "fake-turn",
        url: "ws://127.0.0.1:9999",
        finished_at: "2026-05-19T10:00:00.000Z",
        agent_text: "OK"
      }
    })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.sent, 1);
  assert.strictEqual(result.attempts[0].status, "completed");
  assert.strictEqual(result.attempts[0].prompt, "Harmless injected proof prompt.");
  assert.strictEqual(wakeFiles(storeDir).length, 1);

  fs.rmSync(path.join(workspaceRoot, ".auralis-codextrator"), { recursive: true, force: true });
  storeDir = setupSlot({ threadId: "thread-session-04" });
  result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: true,
    heartbeatMaxMinutes: 60,
    promptMode: "work",
    sandbox: "danger-full-access",
    sendTurnToThread: (input) => ({
      ok: input.prompt.includes("If and only if a task.assign is present") &&
        input.approveSafeCommands === true &&
        path.resolve(input.commandApprovalCwd) === path.resolve(worktree) &&
        path.resolve(input.codextratorMcpRoot) === path.resolve(workspaceRoot) &&
        input.codextratorMcpAgent === "session-04" &&
        input.sandbox === "danger-full-access",
      reason: "fake_completed",
      evidence: {
        thread_id: input.threadId,
        turn_id: "fake-work-turn",
        url: "ws://127.0.0.1:9999",
        finished_at: "2026-05-19T10:05:00.000Z",
        agent_text: "OK"
      }
    })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.sent, 1);
  assert.match(result.attempts[0].prompt, /Codextrator work wake for session-04/);
  assert.match(result.attempts[0].prompt, /record_heartbeat for session-04 with status ok/);
  assert.match(result.attempts[0].prompt, /If and only if a task\.assign is present/);
  assert.match(result.attempts[0].prompt, /Do not touch live\/v1 roots/);
  assert.strictEqual(wakeFiles(storeDir).length, 1);

  fs.rmSync(path.join(workspaceRoot, ".auralis-codextrator"), { recursive: true, force: true });
  storeDir = setupActiveSlot({ threadId: "thread-session-04" });
  result = runDaemonWatchOnce({
    root: workspaceRoot,
    send: true,
    heartbeatMaxMinutes: 60,
    promptMode: "work",
    sandbox: "danger-full-access",
    sendTurnToThread: (input) => ({
      ok: input.prompt.includes("Continue your active Codextrator task") &&
        !input.prompt.includes("claim_next_task") &&
        input.approveSafeCommands === true &&
        path.resolve(input.codextratorMcpRoot) === path.resolve(workspaceRoot) &&
        input.codextratorMcpAgent === "session-04" &&
        input.sandbox === "danger-full-access",
      reason: "fake_completed",
      evidence: {
        thread_id: input.threadId,
        turn_id: "fake-continue-turn",
        url: "ws://127.0.0.1:9999",
        finished_at: "2026-05-19T10:10:00.000Z",
        agent_text: "OK"
      }
    })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.sent, 1);
  assert.strictEqual(result.attempts[0].action, "continue_task");
  assert.match(result.attempts[0].prompt, /Continue your active Codextrator task/);

  console.log("codextrator-daemon-watch.test.js: PASS");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
