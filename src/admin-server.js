"use strict";

const http = require("http");
const path = require("path");
const storeApi = require("./store.js");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function createAdminServer(options = {}) {
  const config = normalizeOptions(options);
  const storeDir = storeApi.ensureStore(config.root, config.agent);

  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(response, renderHtml({
          pollMs: config.pollMs,
          rootLabel: path.resolve(config.root)
        }));
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          name: "auralis-codextrator-admin",
          generated_at: new Date().toISOString()
        });
        return;
      }

      if (url.pathname === "/api/snapshot") {
        sendJson(response, 200, buildSnapshot(storeDir, config));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: "admin_server_error",
        message: error.message
      });
    }
  });

  server.storeDir = storeDir;
  return server;
}

function normalizeOptions(options) {
  return {
    root: path.resolve(options.root || process.env.AURALIS_CODEXTRATOR_ROOT || process.cwd()),
    agent: options.agent || process.env.AURALIS_CODEXTRATOR_AGENT || "coordinator",
    host: options.host || DEFAULT_HOST,
    port: Number(options.port || DEFAULT_PORT),
    heartbeatMaxMinutes: Number(options.heartbeatMaxMinutes || options["heartbeat-max-minutes"] || 100000),
    pollMs: Number(options.pollMs || options["poll-ms"] || 5000)
  };
}

function buildSnapshot(storeDir, config = {}) {
  return {
    generated_at: new Date().toISOString(),
    status: storeApi.buildStatus(storeDir),
    board: storeApi.buildFocusBoardSnapshot(storeDir, {
      viewer_slot: "coordinator"
    }),
    wake_plan: storeApi.buildWakePlan(storeDir, {
      adapter: "codex-app-server",
      heartbeat_max_minutes: Number(config.heartbeatMaxMinutes || 100000)
    })
  };
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

function renderHtml(input) {
  const pollMs = Number(input.pollMs || 5000);
  const rootLabel = escapeHtml(input.rootLabel || "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auralis Codextrator Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-soft: #eef2f6;
      --line: #d7dde5;
      --text: #17202a;
      --muted: #66717f;
      --accent: #176b87;
      --accent-soft: #d9edf3;
      --ok: #26734d;
      --warn: #a15c05;
      --bad: #9c2f2f;
      --violet: #6750a4;
      --shadow: 0 10px 28px rgba(31, 42, 55, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    button, input {
      font: inherit;
    }
    .shell {
      max-width: 1480px;
      margin: 0 auto;
      padding: 20px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
      font-weight: 760;
      letter-spacing: 0;
    }
    .root {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      word-break: break-word;
    }
    .status-line {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pulse {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--warn);
      box-shadow: 0 0 0 3px rgba(161, 92, 5, 0.12);
    }
    .pulse.ok {
      background: var(--ok);
      box-shadow: 0 0 0 3px rgba(38, 115, 77, 0.14);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .metric {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      box-shadow: var(--shadow);
      min-height: 92px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-value {
      margin-top: 10px;
      font-size: 30px;
      line-height: 1;
      font-weight: 760;
    }
    .metric-note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(420px, 0.9fr);
      gap: 14px;
      align-items: start;
    }
    .section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }
    .section-title {
      font-size: 14px;
      font-weight: 760;
      margin: 0;
    }
    .section-subtitle {
      color: var(--muted);
      font-size: 12px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .segmented {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 7px;
      overflow: hidden;
      background: var(--surface);
    }
    .segmented button {
      border: 0;
      background: transparent;
      color: var(--muted);
      min-height: 32px;
      padding: 0 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 650;
    }
    .segmented button.active {
      background: var(--accent);
      color: #fff;
    }
    .search {
      border: 1px solid var(--line);
      border-radius: 7px;
      min-height: 32px;
      padding: 0 10px;
      min-width: 210px;
      background: #fff;
      color: var(--text);
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #e8edf2;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 720;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: #fbfcfd;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .slot-name {
      font-weight: 760;
      white-space: nowrap;
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 12px;
    }
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 11px;
      font-weight: 720;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge.ok { color: var(--ok); background: #e5f4ed; border-color: #b9ddca; }
    .badge.warn { color: var(--warn); background: #fff1db; border-color: #f0cf9c; }
    .badge.bad { color: var(--bad); background: #fbe6e6; border-color: #efbebe; }
    .badge.info { color: var(--accent); background: var(--accent-soft); border-color: #b8dce8; }
    .badge.idle { color: var(--violet); background: #eee9fb; border-color: #d7ccf3; }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      padding: 10px;
      border: 1px solid #e3e8ee;
      border-radius: 7px;
      background: #fff;
    }
    .row-title {
      font-weight: 720;
    }
    .row-meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .empty {
      padding: 24px;
      color: var(--muted);
      text-align: center;
    }
    .scroll {
      max-height: 620px;
      overflow: auto;
    }
    @media (max-width: 1080px) {
      .summary-grid, .layout {
        grid-template-columns: 1fr;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .status-line {
        white-space: normal;
      }
    }
    @media (max-width: 680px) {
      .shell { padding: 12px; }
      h1 { font-size: 21px; }
      th:nth-child(4), td:nth-child(4),
      th:nth-child(5), td:nth-child(5) {
        display: none;
      }
      .section-header {
        align-items: flex-start;
        flex-direction: column;
      }
      .search {
        width: 100%;
        min-width: 0;
      }
      .toolbar {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Auralis Codextrator Admin</h1>
        <div class="root">${rootLabel}</div>
      </div>
      <div class="status-line">
        <span id="pulse" class="pulse"></span>
        <span id="generated">Waiting for ledger snapshot</span>
      </div>
    </header>

    <section class="summary-grid" id="metrics"></section>

    <section class="layout">
      <div class="stack">
        <section class="section">
          <div class="section-header">
            <div>
              <h2 class="section-title">Active Sessions</h2>
              <div class="section-subtitle">Stable slots, health, inbox, and current work.</div>
            </div>
          </div>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Focus</th>
                  <th>Now</th>
                  <th>Heartbeat</th>
                  <th>Thread</th>
                </tr>
              </thead>
              <tbody id="slots"></tbody>
            </table>
          </div>
        </section>

        <section class="section">
          <div class="section-header">
            <div>
              <h2 class="section-title">Task Pool</h2>
              <div class="section-subtitle">Queued, active, reported, integrated, and blocked work.</div>
            </div>
            <div class="toolbar">
              <div class="segmented" id="filters">
                <button class="active" data-filter="open">Open</button>
                <button data-filter="reported">Reports</button>
                <button data-filter="integrated">Integrated</button>
                <button data-filter="all">All</button>
              </div>
              <input id="search" class="search" type="search" placeholder="Search tasks">
            </div>
          </div>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Slot</th>
                  <th>Status</th>
                  <th>Milestone</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody id="tasks"></tbody>
            </table>
          </div>
        </section>
      </div>

      <aside class="stack">
        <section class="section">
          <div class="section-header">
            <div>
              <h2 class="section-title">Current Work</h2>
              <div class="section-subtitle">What each slot is doing or ready to do.</div>
            </div>
          </div>
          <div id="work" class="list"></div>
        </section>

        <section class="section">
          <div class="section-header">
            <div>
              <h2 class="section-title">Milestones</h2>
              <div class="section-subtitle">Shared progress across AOS and Cortex lanes.</div>
            </div>
          </div>
          <div id="milestones" class="list"></div>
        </section>
      </aside>
    </section>
  </main>

  <script>
    const pollMs = ${pollMs};
    let snapshot = null;
    let filter = "open";
    let query = "";

    const el = (id) => document.getElementById(id);

    document.querySelectorAll("#filters button").forEach((button) => {
      button.addEventListener("click", () => {
        filter = button.dataset.filter;
        document.querySelectorAll("#filters button").forEach((item) => item.classList.toggle("active", item === button));
        render();
      });
    });

    el("search").addEventListener("input", (event) => {
      query = event.target.value.trim().toLowerCase();
      render();
    });

    async function load() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        snapshot = await response.json();
        el("pulse").classList.add("ok");
        render();
      } catch (error) {
        el("pulse").classList.remove("ok");
        el("generated").textContent = "Snapshot error: " + error.message;
      }
    }

    function render() {
      if (!snapshot) return;
      const slots = snapshot.status.slots.filter((slot) => slot.slot !== "coordinator");
      const tasks = snapshot.board.tasks || [];
      const openTasks = tasks.filter((task) => !["integrated", "done"].includes(task.status));
      const reportedTasks = tasks.filter((task) => task.status === "reported");
      const integratedTasks = tasks.filter((task) => task.status === "integrated" || task.status === "done");
      const wake = snapshot.wake_plan || {};

      el("generated").textContent = "Updated " + formatDate(snapshot.generated_at) + " | wake=" + (wake.decision || "unknown");
      renderMetrics(slots, tasks, openTasks, reportedTasks, wake);
      renderSlots(slots, tasks);
      renderTasks(tasks);
      renderCurrentWork(slots, tasks);
      renderMilestones(snapshot.board.milestones || []);
    }

    function renderMetrics(slots, tasks, openTasks, reportedTasks, wake) {
      const integrated = tasks.filter((task) => task.status === "integrated" || task.status === "done").length;
      const blocked = tasks.filter((task) => task.status === "blocked").length;
      const pause = (wake.summary && wake.summary.coordinator_pause) || {};
      const pauseRange = pause.range || {};
      const pauseNote = pause.due
        ? "Stop, summarize, then record the pause"
        : (pause.integrations_since_pause || 0) + "/" + (pauseRange.recommended || 35) + " since last summary";
      const metrics = [
        ["Active Slots", slots.length, "Registered worker lanes"],
        ["Open Tasks", openTasks.length, "Queued, active, reported, or blocked"],
        ["Reports Waiting", reportedTasks.length, "Need coordinator verification"],
        ["Integrated", integrated, blocked ? blocked + " blocked" : "All completed receipts"],
        ["Summary Pause", pause.due ? "Due" : (pause.warning ? "Soon" : "Clear"), pauseNote]
      ];
      el("metrics").innerHTML = metrics.map(([label, value, note]) => \`
        <article class="metric">
          <div class="metric-label">\${escapeHtml(label)}</div>
          <div class="metric-value">\${escapeHtml(value)}</div>
          <div class="metric-note">\${escapeHtml(note)}</div>
        </article>
      \`).join("");
    }

    function renderSlots(slots, tasks) {
      const actions = new Map((snapshot.wake_plan.actions || []).map((action) => [action.slot, action]));
      el("slots").innerHTML = slots.map((slot) => {
        const action = actions.get(slot.slot) || {};
        const task = tasks.find((item) => item.task_id === slot.current_task_id);
        const now = task
          ? \`\${badge(task.status)} <div class="small muted">\${escapeHtml(task.title)}</div>\`
          : \`\${badge(action.action || "idle_healthy")} <div class="small muted">\${escapeHtml(action.safe_to_assign ? "Safe to assign" : action.reason || "No active task")}</div>\`;
        const thread = slot.app_server_thread_id ? "headless ready" : "missing";
        return \`
          <tr>
            <td><div class="slot-name">\${escapeHtml(slot.slot)}</div><div class="small muted">\${escapeHtml(slot.project || "")}</div></td>
            <td><div>\${escapeHtml(slot.focus || "")}</div><div class="small muted mono">\${escapeHtml(shortBranch(slot.branch))}</div></td>
            <td>\${now}</td>
            <td>\${badge(slot.heartbeat_status || "missing")}<div class="small muted">\${escapeHtml(formatDate(slot.heartbeat_checked_at))}</div></td>
            <td>\${badge(thread)}<div class="small muted mono">\${escapeHtml(shortId(slot.app_server_thread_id || ""))}</div></td>
          </tr>
        \`;
      }).join("");
    }

    function renderTasks(tasks) {
      let rows = tasks.slice().sort((a, b) => String(b.updated_at || b.assigned_at || "").localeCompare(String(a.updated_at || a.assigned_at || "")));
      if (filter === "open") rows = rows.filter((task) => !["integrated", "done"].includes(task.status));
      if (filter === "reported") rows = rows.filter((task) => task.status === "reported");
      if (filter === "integrated") rows = rows.filter((task) => task.status === "integrated" || task.status === "done");
      if (query) {
        rows = rows.filter((task) => [task.task_id, task.title, task.slot, task.project, task.milestone_id]
          .join(" ")
          .toLowerCase()
          .includes(query));
      }
      el("tasks").innerHTML = rows.length ? rows.slice(0, 120).map((task) => \`
        <tr>
          <td><div class="row-title">\${escapeHtml(task.title)}</div><div class="small muted mono">\${escapeHtml(task.task_id)}</div></td>
          <td class="mono">\${escapeHtml(task.slot)}</td>
          <td>\${badge(task.status)}</td>
          <td><span class="small">\${escapeHtml(task.milestone_id || "")}</span></td>
          <td><span class="small muted">\${escapeHtml(formatDate(task.updated_at || task.assigned_at))}</span></td>
        </tr>
      \`).join("") : \`<tr><td colspan="5"><div class="empty">No tasks match this view.</div></td></tr>\`;
    }

    function renderCurrentWork(slots, tasks) {
      const actions = new Map((snapshot.wake_plan.actions || []).map((action) => [action.slot, action]));
      el("work").innerHTML = slots.map((slot) => {
        const current = tasks.find((task) => task.task_id === slot.current_task_id);
        const latest = latestTaskForSlot(tasks, slot.slot);
        const action = actions.get(slot.slot) || {};
        const title = current ? current.title : (latest ? "Latest: " + latest.title : "No task history");
        const meta = current
          ? \`\${current.task_id} | updated \${formatDate(current.updated_at)}\`
          : \`\${action.action || "idle_healthy"}\${action.reason ? " | " + action.reason : ""}\`;
        return \`
          <div class="row">
            <div>
              <div class="row-title">\${escapeHtml(slot.slot)} · \${escapeHtml(slot.focus || "")}</div>
              <div class="row-meta">\${escapeHtml(title)}</div>
              <div class="row-meta mono">\${escapeHtml(meta)}</div>
            </div>
            <div>\${badge(current ? current.status : (action.safe_to_assign ? "idle" : action.action || "ok"))}</div>
          </div>
        \`;
      }).join("");
    }

    function renderMilestones(milestones) {
      el("milestones").innerHTML = milestones.map((milestone) => {
        const counts = milestone.task_counts || {};
        const countText = Object.entries(counts).map(([key, value]) => key + ":" + value).join("  ");
        return \`
          <div class="row">
            <div>
              <div class="row-title">\${escapeHtml(milestone.title || milestone.milestone_id)}</div>
              <div class="row-meta">\${escapeHtml(milestone.description || "")}</div>
              <div class="row-meta mono">\${escapeHtml(countText || "no tasks")}</div>
            </div>
            <div>\${badge(milestone.status || "planned")}</div>
          </div>
        \`;
      }).join("");
    }

    function latestTaskForSlot(tasks, slot) {
      return tasks
        .filter((task) => task.slot === slot)
        .sort((a, b) => String(b.updated_at || b.assigned_at || "").localeCompare(String(a.updated_at || a.assigned_at || "")))[0] || null;
    }

    function badge(value) {
      const raw = String(value || "unknown");
      const text = raw.replace(/_/g, " ");
      let kind = "info";
      if (["ok", "active", "integrated", "done", "headless ready", "idle healthy"].includes(raw)) kind = "ok";
      if (["queued", "reported", "review", "notify", "wake_slot", "continue_task", "summary_pause_hold"].includes(raw)) kind = "warn";
      if (["blocked", "failed", "stale", "missing", "blocked_restart_required", "pause", "coordinator_summary_pause"].includes(raw)) kind = "bad";
      if (["idle", "idle_healthy"].includes(raw)) kind = "idle";
      return \`<span class="badge \${kind}">\${escapeHtml(text)}</span>\`;
    }

    function shortId(value) {
      return value ? value.slice(0, 8) + "..." + value.slice(-6) : "";
    }

    function shortBranch(value) {
      return value && value.length > 34 ? value.slice(0, 16) + "..." + value.slice(-14) : (value || "");
    }

    function formatDate(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    load();
    setInterval(load, pollMs);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

module.exports = {
  createAdminServer,
  buildSnapshot,
  renderHtml,
  DEFAULT_HOST,
  DEFAULT_PORT
};
