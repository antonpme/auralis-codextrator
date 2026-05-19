"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codextrator-mcp-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-01");

fs.mkdirSync(worktree, { recursive: true });

const proc = spawn(
  process.execPath,
  [
    path.join(repoRoot, "src", "server.js"),
    "--root",
    workspaceRoot,
    "--agent",
    "coordinator"
  ],
  { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }
);

let stdoutBuf = "";
let stderrBuf = "";
const responses = [];

proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // Ignore non-RPC output.
    }
  }
});

proc.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

function send(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(id, method, params = {}) {
  send({ jsonrpc: "2.0", id, method, params });
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const response = responses.find((item) => item.id === id);
    if (response) return response;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for RPC response ${id}; stderr=${stderrBuf}`);
}

function textBody(response) {
  const text = response.result.content[0].text;
  return JSON.parse(text);
}

async function callTool(id, name, args) {
  const response = await rpc(id, "tools/call", {
    name,
    arguments: args
  });
  assert.ok(response.result, `tool ${name} returned a result`);
  assert.strictEqual(response.result.isError, undefined, `tool ${name} should not fail`);
  return textBody(response);
}

(async () => {
  try {
    const init = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "codextrator-mcp-test", version: "1.0.0" },
      capabilities: {}
    });
    assert.strictEqual(init.result.serverInfo.name, "auralis-codextrator");

    const listed = await rpc(2, "tools/list", {});
    const toolNames = listed.result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("register_slot"));
    assert.ok(toolNames.includes("claim_next_task"));
    assert.ok(toolNames.includes("report_commit"));
    assert.ok(toolNames.includes("plan_wake"));
    assert.ok(toolNames.includes("record_wake_attempt"));

    await callTool(3, "register_slot", {
      slot: "session-01",
      project: "demo-project",
      identity: "elian",
      focus: "MCP slice",
      worktree,
      branch: "codex/mcp-demo"
    });

    await callTool(100, "record_heartbeat", {
      slot: "session-01",
      status: "ok",
      run_id: "mcp-test-run"
    });

    await callTool(4, "create_task", {
      slot: "session-01",
      task_id: "mcp-task-1",
      title: "MCP task",
      message: "Use the MCP inbox and task state."
    });

    let status = await callTool(5, "get_status", {});
    let session = status.slots.find((slot) => slot.slot === "session-01");
    assert.strictEqual(session.unread, 1);
    assert.strictEqual(session.current_task_id, "mcp-task-1");
    assert.strictEqual(session.current_task_status, "queued");
    assert.strictEqual(session.thread_id, null);
    assert.strictEqual(session.app_server_thread_id, null);

    let wakePlan = await callTool(101, "plan_wake", {
      heartbeat_max_minutes: 60
    });
    let wakeAction = wakePlan.actions.find((action) => action.slot === "session-01");
    assert.strictEqual(wakePlan.decision, "WAKE");
    assert.strictEqual(wakeAction.action, "wake_slot");
    assert.strictEqual(wakeAction.safe_to_assign, false);
    assert.match(wakeAction.prompt, /claim_next_task/);
    assert.strictEqual(wakeAction.adapter_request.mode, "dry-run");

    const appServerPlan = await callTool(104, "plan_wake", {
      adapter: "codex-app-server",
      heartbeat_max_minutes: 60
    });
    wakeAction = appServerPlan.actions.find((action) => action.slot === "session-01");
    assert.strictEqual(wakeAction.adapter_request.adapter, "codex-app-server");
    assert.deepStrictEqual(wakeAction.adapter_request.requires, ["app_server_thread_id"]);
    assert.strictEqual(wakeAction.adapter_request.method, "turn/start");

    await callTool(105, "register_slot", {
      slot: "session-01",
      project: "demo-project",
      identity: "elian",
      focus: "MCP slice",
      worktree,
      branch: "codex/mcp-demo",
      app_server_thread_id: "019e-test-thread",
      app_server_url: "ws://127.0.0.1:4575"
    });

    status = await callTool(106, "get_status", {});
    session = status.slots.find((slot) => slot.slot === "session-01");
    assert.strictEqual(session.app_server_thread_id, "019e-test-thread");
    assert.strictEqual(session.app_server_url, "ws://127.0.0.1:4575");

    const readyAppServerPlan = await callTool(107, "plan_wake", {
      adapter: "codex-app-server",
      heartbeat_max_minutes: 60
    });
    wakeAction = readyAppServerPlan.actions.find((action) => action.slot === "session-01");
    assert.strictEqual(wakeAction.adapter_request.adapter, "codex-app-server");
    assert.strictEqual(wakeAction.adapter_request.mode, "ready");
    assert.strictEqual(wakeAction.adapter_request.params.threadId, "019e-test-thread");
    assert.deepStrictEqual(wakeAction.adapter_request.params.input, [{ type: "text", text: wakeAction.prompt }]);

    const wakeAttempt = await callTool(102, "record_wake_attempt", {
      slot: "session-01",
      action: "wake_slot",
      adapter: "notify-only",
      status: "dry_run",
      reason: "mcp test"
    });
    assert.strictEqual(wakeAttempt.attempt.slot, "session-01");
    assert.strictEqual(wakeAttempt.attempt.status, "dry_run");

    const peeked = await callTool(6, "read_inbox", {
      slot: "session-01",
      mark_read: false
    });
    assert.strictEqual(peeked.unread_count, 1);
    assert.strictEqual(peeked.messages[0].type, "task.assign");
    assert.strictEqual(peeked.messages[0].task_id, "mcp-task-1");

    const claimed = await callTool(7, "claim_next_task", {
      slot: "session-01"
    });
    assert.strictEqual(claimed.task.task_id, "mcp-task-1");
    assert.strictEqual(claimed.task.status, "active");

    status = await callTool(8, "get_status", {});
    session = status.slots.find((slot) => slot.slot === "session-01");
    assert.strictEqual(session.unread, 0);
    assert.strictEqual(session.current_task_status, "active");

    await callTool(9, "report_commit", {
      slot: "session-01",
      sha: "abc1234567890",
      branch: "codex/mcp-demo",
      subject: "feat: mcp demo",
      changed: ["M\truntime/demo.js"],
      worktree
    });

    status = await callTool(10, "get_status", {});
    const coordinator = status.slots.find((slot) => slot.slot === "coordinator");
    session = status.slots.find((slot) => slot.slot === "session-01");
    assert.strictEqual(coordinator.unread, 1);
    assert.strictEqual(session.current_task_status, "reported");

    wakePlan = await callTool(103, "plan_wake", {
      heartbeat_max_minutes: 60
    });
    assert.strictEqual(wakePlan.decision, "NOTIFY");
    assert.ok(wakePlan.actions.some((action) => action.slot === "coordinator" && action.action === "coordinator_inbox"));

    const reportInbox = await callTool(11, "read_inbox", {
      slot: "coordinator"
    });
    assert.strictEqual(reportInbox.unread_count, 1);
    assert.strictEqual(reportInbox.messages[0].type, "commit_report");
    assert.strictEqual(reportInbox.messages[0].payload.sha, "abc1234567890");

    await callTool(12, "update_task", {
      task_id: "mcp-task-1",
      status: "integrated",
      commit: "mainabc123"
    });

    status = await callTool(13, "get_status", {});
    session = status.slots.find((slot) => slot.slot === "session-01");
    assert.strictEqual(session.current_task_id, null);
    assert.strictEqual(session.current_task_status, "integrated");

    console.log("codextrator-mcp.test.js: PASS");
  } finally {
    proc.kill("SIGINT");
    await sleep(100);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  proc.kill("SIGKILL");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.error(error);
  console.error(stderrBuf);
  process.exit(1);
});
