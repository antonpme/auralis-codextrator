"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const store = require("../src/store.js");

const repoRoot = path.resolve(__dirname, "..");
const watchCli = path.join(repoRoot, "bin", "codextrator-mcp-watch.js");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codextrator-watch-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-01");

function runWatch(args) {
  return execFileSync(process.execPath, [watchCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

try {
  fs.mkdirSync(worktree, { recursive: true });
  const storeDir = store.ensureStore(workspaceRoot, "coordinator");
  store.registerSlot(storeDir, {
    slot: "session-01",
    project: "demo-project",
    identity: "elian",
    focus: "Wake proof",
    worktree,
    branch: "codex/wake-proof"
  });
  store.recordHeartbeat(storeDir, {
    slot: "session-01",
    status: "ok",
    run_id: "watch-test-run"
  });
  store.createTask(storeDir, {
    slot: "session-01",
    task_id: "watch-task-1",
    title: "Wake me",
    message: "Claim this through MCP."
  });

  let plan = JSON.parse(runWatch([
    "--root",
    workspaceRoot,
    "--json",
    "--heartbeat-max-minutes",
    "60"
  ]));
  assert.strictEqual(plan.decision, "WAKE");
  assert.strictEqual(plan.safety.mutates_tasks, false);
  assert.strictEqual(plan.safety.desktop_automation_resume, false);
  let action = plan.actions.find((item) => item.slot === "session-01");
  assert.strictEqual(action.action, "wake_slot");
  assert.match(action.prompt, /claim_next_task/);

  plan = JSON.parse(runWatch([
    "--root",
    workspaceRoot,
    "--json",
    "--adapter",
    "codex-app-server",
    "--heartbeat-max-minutes",
    "60"
  ]));
  action = plan.actions.find((item) => item.slot === "session-01");
  assert.strictEqual(action.adapter_request.adapter, "codex-app-server");
  assert.deepStrictEqual(action.adapter_request.requires, ["app_server_thread_id"]);

  plan = JSON.parse(runWatch([
    "--root",
    workspaceRoot,
    "--json",
    "--heartbeat-max-minutes",
    "60",
    "--record-dry-run"
  ]));
  assert.strictEqual(plan.recorded_attempts.length, 1);
  const wakeFiles = fs.readdirSync(path.join(workspaceRoot, ".auralis-codextrator", "wake"));
  assert.strictEqual(wakeFiles.length, 1);

  store.claimNextTask(storeDir, "session-01");
  plan = JSON.parse(runWatch([
    "--root",
    workspaceRoot,
    "--json",
    "--adapter",
    "codex-app-server",
    "--heartbeat-max-minutes",
    "60"
  ]));
  assert.strictEqual(plan.decision, "WAKE");
  action = plan.actions.find((item) => item.slot === "session-01");
  assert.strictEqual(action.action, "continue_task");
  assert.strictEqual(action.reason, "task_active");
  assert.match(action.prompt, /Continue your active Codextrator task/);
  assert.strictEqual(action.adapter_request.adapter, "codex-app-server");
  assert.deepStrictEqual(action.adapter_request.requires, ["app_server_thread_id"]);

  const parentRoot = path.join(tmpRoot, "parent-root");
  const legacyStore = path.join(parentRoot, ".auralis-codextrator");
  fs.mkdirSync(legacyStore, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStore, "registry.json"),
    JSON.stringify({ version: 1, name: "legacy-cli-store", coordinator: {}, sessions: {} }, null, 2),
    "utf8"
  );
  const nestedRoot = path.join(parentRoot, ".codextrator-mcp-root");
  const nestedStore = store.ensureStore(nestedRoot, "coordinator");
  store.registerSlot(nestedStore, {
    slot: "session-nested",
    project: "demo-project",
    identity: "elian",
    focus: "Nested MCP root",
    worktree: path.join(parentRoot, "worktrees", "nested"),
    branch: "codex/nested-root"
  });
  store.recordHeartbeat(nestedStore, {
    slot: "session-nested",
    status: "ok",
    run_id: "nested-run"
  });
  store.createTask(nestedStore, {
    slot: "session-nested",
    task_id: "nested-task-1",
    title: "Nested wake",
    message: "Use the nested MCP root."
  });
  plan = JSON.parse(runWatch([
    "--root",
    parentRoot,
    "--json",
    "--heartbeat-max-minutes",
    "60"
  ]));
  assert.ok(plan.actions.some((item) => item.slot === "session-nested" && item.action === "wake_slot"));

  console.log("codextrator-watch.test.js: PASS");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
