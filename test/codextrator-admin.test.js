"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storeApi = require("../src/store.js");
const { createAdminServer, buildSnapshot, renderHtml } = require("../src/admin-server.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codextrator-admin-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const worktree = path.join(workspaceRoot, "worktrees", "session-05");

async function main() {
  try {
    fs.mkdirSync(worktree, { recursive: true });
    const store = storeApi.ensureStore(workspaceRoot, "coordinator");

    storeApi.registerSlot(store, {
      slot: "session-05",
      identity: "elian",
      project: "auralis-cortex",
      focus: "Entity Core",
      worktree,
      branch: "codex/cortex-entity-core",
      app_server_thread_id: "thread-headless-05"
    });
    storeApi.recordHeartbeat(store, {
      slot: "session-05",
      status: "ok",
      run_id: "session-05-headless"
    });
    storeApi.upsertMilestone(store, {
      milestone_id: "cortex-v1",
      title: "Cortex v1",
      status: "active"
    });
    storeApi.upsertLane(store, {
      lane_id: "session-05",
      title: "Entity Core",
      owner_slot: "session-05",
      project: "auralis-cortex"
    });
    storeApi.createTask(store, {
      slot: "session-05",
      task_id: "session-05-demo",
      title: "Entity context policy",
      message: "Build a fixture-backed policy.",
      milestone_id: "cortex-v1",
      lane_id: "session-05"
    });

    const snapshot = buildSnapshot(store, { heartbeatMaxMinutes: 60 });
    assert.strictEqual(snapshot.status.slots.find((slot) => slot.slot === "session-05").app_server_thread_id, "thread-headless-05");
    assert.strictEqual(snapshot.board.progress.total_tasks, 1);
    assert.strictEqual(snapshot.wake_plan.decision, "WAKE");

    const html = renderHtml({ pollMs: 1000, rootLabel: workspaceRoot });
    assert.match(html, /Auralis Codextrator Admin/);
    assert.match(html, /api\/snapshot/);

    const server = createAdminServer({
      root: workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      heartbeatMaxMinutes: 60,
      pollMs: 1000
    });
    await listen(server);
    try {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const health = await getJson(`${baseUrl}/api/health`);
      assert.strictEqual(health.ok, true);

      const liveSnapshot = await getJson(`${baseUrl}/api/snapshot`);
      assert.strictEqual(liveSnapshot.board.board.name, "Auralis Codextrator Focus Board");
      assert.strictEqual(liveSnapshot.status.slots.some((slot) => slot.slot === "session-05"), true);

      const page = await getText(`${baseUrl}/`);
      assert.match(page, /Active Sessions/);
      assert.match(page, /Task Pool/);
    } finally {
      await close(server);
    }

    console.log("codextrator-admin.test.js: PASS");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const response = await fetch(url);
  assert.strictEqual(response.status, 200);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  assert.strictEqual(response.status, 200);
  return response.text();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
