"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const STORE_NAME = ".auralis-codextrator";
const MCP_ROOT_NAME = ".codextrator-mcp-root";
const PRODUCT_NAME = "Auralis Codenator";
const PRODUCT_ID = "auralis-codenator";
const LEGACY_PRODUCT_ID = "auralis-codextrator";
const FOCUS_BOARD_NAME = "Auralis Codenator Focus Board";
const FOCUS_BOARD_DESCRIPTION = "Shared backlog, milestones, lanes, assignments, reports, and integration receipts for Codenator focus slots.";
const LEGACY_FOCUS_BOARD_NAME = "auralis codextrator focus board";
const LEGACY_FOCUS_BOARD_DESCRIPTION = "shared backlog, milestones, lanes, assignments, reports, and integration receipts for codextrator focus slots.";
const MINUTE_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_MAX_MINUTES = 15;
const SUMMARY_PAUSE_MIN_INTEGRATIONS = 30;
const SUMMARY_PAUSE_RECOMMENDED_INTEGRATIONS = 35;
const SUMMARY_PAUSE_MAX_INTEGRATIONS = 40;
const SUMMARY_PAUSE_TYPES = new Set(["coordinator.summary_pause", "summary_pause"]);

function now() {
  return new Date().toISOString();
}

function normalizePath(value) {
  if (!value) return "";
  return path.resolve(value).replace(/\\/g, "/");
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeStamp() {
  return now().replace(/[:.]/g, "-");
}

function makeId(prefix = "msg") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function resolveStoreRoot(root) {
  const resolved = path.resolve(root);
  const nestedRoot = path.join(resolved, MCP_ROOT_NAME);
  const nestedRegistry = path.join(nestedRoot, STORE_NAME, "registry.json");
  const directRegistry = path.join(resolved, STORE_NAME, "registry.json");
  if (fs.existsSync(nestedRegistry)) {
    const nestedVersion = registryVersion(nestedRegistry);
    const directVersion = registryVersion(directRegistry);
    if (nestedVersion >= 2 && directVersion < 2) return nestedRoot;
  }
  return resolved;
}

function registryVersion(file) {
  try {
    return Number(readJson(file, {}).version || 0);
  } catch {
    return 0;
  }
}

function storePath(root) {
  return path.join(resolveStoreRoot(root), STORE_NAME);
}

function ensureStore(root, agent = "coordinator") {
  const store = storePath(root);
  for (const name of [
    "archive",
    "board",
    "cursors",
    "heartbeat",
    "hooks",
    "inbox",
    "messages",
    "reports",
    "tasks",
    "wake",
    "watchdog"
  ]) {
    fs.mkdirSync(path.join(store, name), { recursive: true });
  }

  const registryFile = path.join(store, "registry.json");
  if (!fs.existsSync(registryFile)) {
    writeJson(registryFile, {
      version: 2,
      name: PRODUCT_ID,
      legacy_names: [LEGACY_PRODUCT_ID],
      transport: "mcp",
      created_at: now(),
      updated_at: now(),
      coordinator: {
        slot: "coordinator",
        identity: agent,
        status: "active"
      },
      sessions: {}
    });
  }

  return store;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readRegistry(store) {
  return readJson(path.join(store, "registry.json"));
}

function writeRegistry(store, registry) {
  registry.updated_at = now();
  writeJson(path.join(store, "registry.json"), registry);
}

function ledgerPath(store) {
  return path.join(store, "messages", "ledger.jsonl");
}

function readLedger(store) {
  const file = ledgerPath(store);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const message = JSON.parse(line);
      return {
        seq: message.seq || index + 1,
        ...message
      };
    });
}

function appendLedger(store, message) {
  const messages = readLedger(store);
  const seq = messages.length === 0 ? 1 : Math.max(...messages.map((item) => item.seq || 0)) + 1;
  const full = {
    seq,
    id: message.id || makeId("msg"),
    type: message.type || "message",
    from: message.from || "unknown",
    to: message.to,
    subject: message.subject || "",
    message: message.message || "",
    task_id: message.task_id || null,
    payload: message.payload || {},
    created_at: message.created_at || now(),
    cwd: message.cwd ? normalizePath(message.cwd) : ""
  };
  fs.mkdirSync(path.dirname(ledgerPath(store)), { recursive: true });
  fs.appendFileSync(ledgerPath(store), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

function cursorPath(store, slot) {
  return path.join(store, "cursors", `${safeFileName(slot)}.json`);
}

function readCursor(store, slot) {
  const cursor = readJson(cursorPath(store, slot), { last_seq: 0 });
  return Number(cursor.last_seq || 0);
}

function writeCursor(store, slot, lastSeq) {
  writeJson(cursorPath(store, slot), {
    slot,
    last_seq: lastSeq,
    updated_at: now()
  });
}

function unreadMessages(store, slot) {
  const cursor = readCursor(store, slot);
  return readLedger(store).filter((message) => {
    if ((message.seq || 0) <= cursor) return false;
    if (message.from === slot) return false;
    return message.to === slot || message.to === "all";
  });
}

function readInbox(store, slot, options = {}) {
  const messages = unreadMessages(store, slot);
  if (options.markRead !== false && messages.length > 0) {
    writeCursor(store, slot, Math.max(...messages.map((message) => message.seq || 0)));
  }
  return messages;
}

function registerSlot(store, input) {
  const registry = readRegistry(store);
  const previous = registry.sessions[input.slot] || {};
  registry.sessions[input.slot] = {
    ...previous,
    slot: input.slot,
    identity: input.identity || previous.identity || "developer",
    project: input.project || previous.project || "",
    focus: input.focus || previous.focus || "",
    worktree: input.worktree ? normalizePath(input.worktree) : (previous.worktree || ""),
    branch: input.branch || previous.branch || "",
    status: input.status || previous.status || "active",
    inbox: `cursors/${input.slot}.json`,
    run_id: input.run_id || previous.run_id || null,
    app_server_thread_id: input.app_server_thread_id !== undefined
      ? (input.app_server_thread_id || null)
      : (previous.app_server_thread_id || null),
    app_server_url: input.app_server_url !== undefined
      ? (input.app_server_url || null)
      : (previous.app_server_url || null),
    updated_at: now()
  };
  writeRegistry(store, registry);
  return registry.sessions[input.slot];
}

function taskPath(store, taskId) {
  return path.join(store, "tasks", `${safeFileName(taskId)}.json`);
}

function normalizeTask(input) {
  const createdAt = input.created_at || now();
  return {
    version: 2,
    task_id: input.task_id,
    slot: input.slot,
    title: input.title,
    subject: input.subject || input.title,
    status: input.status || "queued",
    project: input.project || "",
    branch: input.branch || "",
    worktree: input.worktree || "",
    message: input.message || "",
    created_by: input.created_by || "coordinator",
    assigned_at: input.assigned_at || createdAt,
    started_at: input.started_at || null,
    reported_at: input.reported_at || null,
    integrated_at: input.integrated_at || null,
    commit: input.commit || null,
    tests: input.tests || [],
    blockers: input.blockers || [],
    milestone_id: input.milestone_id || input.milestone || null,
    lane_id: input.lane_id || input.lane || null,
    dependency_ids: normalizeStringArray(input.dependency_ids || input.dependencies),
    acceptance_criteria: normalizeStringArray(input.acceptance_criteria),
    required_receipts: normalizeStringArray(input.required_receipts),
    visible_progress_summary: input.visible_progress_summary || "",
    next_policy: input.next_policy || "claim_via_mcp_then_report_commit",
    created_at: createdAt,
    updated_at: input.updated_at || createdAt
  };
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function makeTaskId(slot) {
  return `${slot}-${safeStamp().replace(/-/g, "").slice(0, 15)}-${crypto.randomBytes(3).toString("hex")}`;
}

function writeTask(store, task) {
  writeJson(taskPath(store, task.task_id), task);
}

function readTask(store, taskId) {
  return readJson(taskPath(store, taskId));
}

function listTasks(store) {
  const dir = path.join(store, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)))
    .sort((left, right) => String(left.assigned_at || left.created_at).localeCompare(String(right.assigned_at || right.created_at)));
}

function updateSlotTask(store, slot, taskId, taskStatus) {
  const registry = readRegistry(store);
  const session = slot === "coordinator" ? registry.coordinator : registry.sessions[slot];
  if (!session) return null;
  session.current_task_id = taskStatus === "integrated" || taskStatus === "done" ? null : taskId;
  session.current_task_status = taskStatus;
  session.updated_at = now();
  writeRegistry(store, registry);
  return session;
}

function createTask(store, input) {
  const registry = readRegistry(store);
  const session = registry.sessions[input.slot] || {};
  const task = normalizeTask({
    task_id: input.task_id || makeTaskId(input.slot),
    slot: input.slot,
    title: input.title,
    subject: input.subject || input.title,
    status: input.status || "queued",
    message: input.message,
    created_by: input.created_by || "coordinator",
    project: input.project || session.project || "",
    branch: input.branch || session.branch || "",
    worktree: input.worktree ? normalizePath(input.worktree) : (session.worktree || ""),
    milestone_id: input.milestone_id || input.milestone,
    lane_id: input.lane_id || input.lane,
    dependency_ids: input.dependency_ids || input.dependencies,
    acceptance_criteria: input.acceptance_criteria,
    required_receipts: input.required_receipts,
    visible_progress_summary: input.visible_progress_summary
  });
  writeTask(store, task);
  updateSlotTask(store, input.slot, task.task_id, task.status);
  const message = appendLedger(store, {
    type: "task.assign",
    from: task.created_by,
    to: input.slot,
    subject: task.subject,
    message: task.message,
    task_id: task.task_id,
    payload: {
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      branch: task.branch,
      worktree: task.worktree
    }
  });
  return { task, message };
}

function focusBoardPath(store) {
  return path.join(store, "board", "focus-board.json");
}

function defaultFocusBoard() {
  return {
    version: 1,
    name: FOCUS_BOARD_NAME,
    description: FOCUS_BOARD_DESCRIPTION,
    milestones: [],
    lanes: [],
    created_at: now(),
    updated_at: now()
  };
}

function readFocusBoard(store) {
  const file = focusBoardPath(store);
  if (!fs.existsSync(file)) {
    const board = defaultFocusBoard();
    writeJson(file, board);
    return board;
  }
  const board = readJson(file);
  const defaultBoard = defaultFocusBoard();
  const normalizedName = String(board.name || "").toLowerCase() === LEGACY_FOCUS_BOARD_NAME
    ? defaultBoard.name
    : board.name;
  const normalizedDescription = String(board.description || "").toLowerCase() === LEGACY_FOCUS_BOARD_DESCRIPTION
    ? defaultBoard.description
    : board.description;
  return {
    ...defaultBoard,
    ...board,
    name: normalizedName,
    description: normalizedDescription,
    milestones: Array.isArray(board.milestones) ? board.milestones : [],
    lanes: Array.isArray(board.lanes) ? board.lanes : []
  };
}

function writeFocusBoard(store, board) {
  writeJson(focusBoardPath(store), {
    ...board,
    updated_at: now()
  });
}

function upsertMilestone(store, input) {
  const milestoneId = input.milestone_id || input.id;
  if (!milestoneId) throw new Error("milestone_id is required");
  const board = readFocusBoard(store);
  const previous = board.milestones.find((item) => item.milestone_id === milestoneId) || {};
  const milestone = {
    milestone_id: milestoneId,
    title: input.title || previous.title || milestoneId,
    status: input.status || previous.status || "planned",
    description: input.description || previous.description || "",
    order: input.order !== undefined ? Number(input.order) : (previous.order || 0),
    created_at: previous.created_at || now(),
    updated_at: now()
  };
  board.milestones = [
    ...board.milestones.filter((item) => item.milestone_id !== milestoneId),
    milestone
  ].sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || left.milestone_id.localeCompare(right.milestone_id));
  writeFocusBoard(store, board);
  return milestone;
}

function upsertLane(store, input) {
  const laneId = input.lane_id || input.id;
  if (!laneId) throw new Error("lane_id is required");
  const board = readFocusBoard(store);
  const previous = board.lanes.find((item) => item.lane_id === laneId) || {};
  const lane = {
    lane_id: laneId,
    title: input.title || previous.title || laneId,
    owner_slot: input.owner_slot || input.slot || previous.owner_slot || "",
    project: input.project || previous.project || "",
    status: input.status || previous.status || "active",
    description: input.description || previous.description || "",
    order: input.order !== undefined ? Number(input.order) : (previous.order || 0),
    created_at: previous.created_at || now(),
    updated_at: now()
  };
  board.lanes = [
    ...board.lanes.filter((item) => item.lane_id !== laneId),
    lane
  ].sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || left.lane_id.localeCompare(right.lane_id));
  writeFocusBoard(store, board);
  return lane;
}

function updateTask(store, taskId, input) {
  const task = readTask(store, taskId);
  if (input.status) task.status = input.status;
  if (input.commit) task.commit = input.commit;
  if (input.tests) task.tests = Array.isArray(input.tests) ? input.tests : String(input.tests).split(",").map((item) => item.trim()).filter(Boolean);
  if (input.blocker) {
    task.blockers = [
      ...(task.blockers || []),
      { message: input.blocker, recorded_at: now() }
    ];
    if (!input.status) task.status = "blocked";
  }
  if (task.status === "active" && !task.started_at) task.started_at = now();
  if (task.status === "reported" && !task.reported_at) task.reported_at = now();
  if (task.status === "integrated" && !task.integrated_at) task.integrated_at = now();
  task.updated_at = now();
  writeTask(store, task);
  updateSlotTask(store, task.slot, task.task_id, task.status);
  return task;
}

function claimNextTask(store, slot) {
  const messages = readInbox(store, slot, { markRead: true });
  let taskMessage = messages.find((message) => message.type === "task.assign" && message.task_id);
  let task = null;
  if (taskMessage) {
    task = readTask(store, taskMessage.task_id);
  } else {
    const registry = readRegistry(store);
    const session = registry.sessions[slot] || {};
    if (session.current_task_id) task = readTask(store, session.current_task_id);
  }
  if (!task) return { task: null, messages };
  if (task.slot !== slot) throw new Error(`Task ${task.task_id} belongs to ${task.slot}, not ${slot}`);
  if (task.status === "queued" || task.status === "assigned") {
    task.status = "active";
    task.started_at = task.started_at || now();
    task.updated_at = now();
    writeTask(store, task);
    updateSlotTask(store, slot, task.task_id, task.status);
  }
  return { task, messages };
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function detectCommit(input) {
  const worktree = input.worktree ? path.resolve(input.worktree) : process.cwd();
  const needsGit = !input.sha || !input.branch || !input.subject || input.changed === undefined;
  const sha = input.sha || git(["rev-parse", "HEAD"], worktree).trim();
  const branch = input.branch || git(["branch", "--show-current"], worktree).trim();
  const subject = input.subject || git(["log", "-1", "--pretty=%s"], worktree).trim();
  const body = input.body || (needsGit ? git(["log", "-1", "--pretty=%b"], worktree).trim() : "");
  const changed = input.changed || git(["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"], worktree)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    sha,
    branch,
    subject,
    body,
    changed,
    worktree: normalizePath(worktree)
  };
}

function reportCommit(store, input) {
  const report = {
    id: makeId("report"),
    type: "commit_report",
    slot: input.slot,
    ...detectCommit(input),
    created_at: now()
  };
  writeJson(path.join(store, "reports", `${safeStamp()}_${safeFileName(input.slot)}_${report.sha.slice(0, 12)}.json`), report);

  const activeTasks = listTasks(store).filter((task) => task.slot === input.slot && task.status === "active");
  if (activeTasks.length > 0) {
    const task = activeTasks[activeTasks.length - 1];
    updateTask(store, task.task_id, {
      status: "reported",
      commit: report.sha
    });
  }

  const message = appendLedger(store, {
    type: "commit_report",
    from: input.slot,
    to: "coordinator",
    subject: `Commit ${report.sha.slice(0, 7)}: ${report.subject}`,
    message: renderCommitReport(report),
    payload: report,
    cwd: report.worktree
  });
  return { report, message };
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

function recordHeartbeat(store, input) {
  const heartbeat = {
    slot: input.slot,
    status: input.status || "ok",
    run_id: input.run_id || null,
    checked_at: now(),
    error: input.error || null
  };
  writeJson(path.join(store, "heartbeat", `${safeFileName(input.slot)}.json`), heartbeat);

  const registry = readRegistry(store);
  const session = input.slot === "coordinator" ? registry.coordinator : registry.sessions[input.slot];
  if (session) {
    session.heartbeat = heartbeat;
    session.heartbeat_status = heartbeat.status;
    session.heartbeat_checked_at = heartbeat.checked_at;
    if (heartbeat.run_id) session.run_id = heartbeat.run_id;
    session.updated_at = now();
    writeRegistry(store, registry);
  }
  return heartbeat;
}

function isIntegratedTask(task) {
  return task.status === "integrated" || task.status === "done";
}

function buildSummaryPausePolicy(store, tasks = listTasks(store)) {
  const integratedCount = tasks.filter((task) => isIntegratedTask(task)).length;
  const markers = readLedger(store)
    .filter((message) => SUMMARY_PAUSE_TYPES.has(message.type))
    .map((message) => ({
      seq: Number(message.seq || 0),
      created_at: message.created_at || "",
      integration_count: Number(message.payload && message.payload.integration_count)
    }))
    .filter((marker) => Number.isFinite(marker.integration_count))
    .sort((a, b) => {
      if (a.integration_count !== b.integration_count) return a.integration_count - b.integration_count;
      return a.seq - b.seq;
    });
  const lastMarker = markers.length ? markers[markers.length - 1] : null;
  const lastPauseCount = lastMarker
    ? Math.min(lastMarker.integration_count, integratedCount)
    : 0;
  const integrationsSincePause = Math.max(0, integratedCount - lastPauseCount);
  const due = integrationsSincePause >= SUMMARY_PAUSE_RECOMMENDED_INTEGRATIONS;
  const warning = !due && integrationsSincePause >= SUMMARY_PAUSE_MIN_INTEGRATIONS;

  return {
    policy: "coordinator_summary_pause",
    range: {
      min: SUMMARY_PAUSE_MIN_INTEGRATIONS,
      recommended: SUMMARY_PAUSE_RECOMMENDED_INTEGRATIONS,
      max: SUMMARY_PAUSE_MAX_INTEGRATIONS
    },
    integrated_count: integratedCount,
    last_pause_integration_count: lastPauseCount,
    last_pause_at: lastMarker ? lastMarker.created_at : null,
    integrations_since_pause: integrationsSincePause,
    next_pause_at: lastPauseCount + SUMMARY_PAUSE_RECOMMENDED_INTEGRATIONS,
    due,
    warning,
    action: due ? "stop_and_summarize" : (warning ? "prepare_summary_pause" : "continue"),
    reason: due ? "summary_pause_due" : (warning ? "summary_pause_soon" : ""),
    instructions: "When due, stop the coordinator loop, give Ton a brief summary, then call record_summary_pause before resuming wake or assignment."
  };
}

function recordSummaryPause(store, input = {}) {
  const tasks = listTasks(store);
  const policy = buildSummaryPausePolicy(store, tasks);
  const requestedCount = Number(input.integration_count);
  const integrationCount = Number.isFinite(requestedCount)
    ? requestedCount
    : policy.integrated_count;
  const summary = input.summary || "";
  const marker = appendLedger(store, {
    type: "coordinator.summary_pause",
    from: input.from || "coordinator",
    to: "coordinator",
    subject: input.subject || `Coordinator summary pause at ${integrationCount} integrations`,
    message: summary || "Coordinator stopped for the periodic summary pause.",
    payload: {
      integration_count: integrationCount,
      integrations_since_pause: Math.max(0, integrationCount - policy.last_pause_integration_count),
      threshold: SUMMARY_PAUSE_RECOMMENDED_INTEGRATIONS,
      range: policy.range,
      summary,
      recorded_at: now()
    }
  });

  return {
    marker,
    policy: buildSummaryPausePolicy(store, tasks)
  };
}

function buildWakePlan(store, input = {}) {
  const checkedAt = input.checked_at || now();
  const heartbeatMaxMinutes = Number(input.heartbeat_max_minutes || DEFAULT_HEARTBEAT_MAX_MINUTES);
  const heartbeatMaxMs = heartbeatMaxMinutes * MINUTE_MS;
  const adapter = input.adapter || "notify-only";
  const status = buildStatus(store);
  const summaryPause = buildSummaryPausePolicy(store, status.tasks);

  if (summaryPause.due) {
    const actions = status.slots.map((slot) => planSummaryPauseAction(slot, summaryPause));
    return {
      version: 1,
      decision: "PAUSE",
      checked_at: checkedAt,
      adapter,
      source: "mcp-ledger",
      safety: {
        mutates_sessions: false,
        mutates_tasks: false,
        mutates_inbox: false,
        desktop_automation_resume: false,
        can_assign_new_work: false
      },
      summary: {
        slots: actions.length,
        wake: 0,
        notify: actions.filter((action) => action.notify === true).length,
        blocked: actions.filter((action) => action.blocked === true).length,
        coordinator_pause: summaryPause
      },
      actions
    };
  }

  const unreadBySlot = new Map(status.slots.map((slot) => [slot.slot, unreadMessages(store, slot.slot)]));
  const actions = status.slots.map((slot) => planWakeAction(slot, {
    adapter,
    checkedAt,
    heartbeatMaxMs,
    unread: unreadBySlot.get(slot.slot) || []
  }));
  const wakeActions = actions.filter((action) => action.action === "wake_slot" || action.action === "continue_task");
  const notifyActions = actions.filter((action) => action.notify === true);
  const blockedActions = actions.filter((action) => action.blocked === true);
  const unsafeSlotActions = actions.filter((action) => action.slot !== "coordinator" && action.safe_to_assign === false);
  const decision = wakeActions.length > 0
    ? "WAKE"
    : (notifyActions.length > 0 ? "NOTIFY" : "DONT_NOTIFY");

  return {
    version: 1,
    decision,
    checked_at: checkedAt,
    adapter,
    source: "mcp-ledger",
    safety: {
      mutates_sessions: false,
      mutates_tasks: false,
      mutates_inbox: false,
      desktop_automation_resume: false,
      can_assign_new_work: unsafeSlotActions.length === 0 && wakeActions.length === 0 && notifyActions.length === 0
    },
    summary: {
      slots: actions.length,
      wake: wakeActions.length,
      notify: notifyActions.length,
      blocked: blockedActions.length,
      coordinator_pause: summaryPause
    },
    actions
  };
}

function planSummaryPauseAction(slot, policy) {
  if (slot.slot === "coordinator") {
    return baseWakeAction(slot, {
      action: "coordinator_summary_pause",
      reason: policy.reason,
      notify: true,
      blocked: true,
      safe_to_assign: false,
      prompt: [
        `Stop the coordinator loop for the scheduled ${PRODUCT_NAME} summary pause.`,
        `Integrations since last pause: ${policy.integrations_since_pause}.`,
        "Give Ton a brief summary, then call record_summary_pause with the current integration count before assigning or waking more work."
      ].join("\n")
    });
  }

  return baseWakeAction(slot, {
    action: "summary_pause_hold",
    reason: policy.reason,
    blocked: true,
    safe_to_assign: false
  });
}

function planWakeAction(slot, options) {
  const heartbeatProblem = heartbeatBlocker(slot, options);
  if (slot.slot === "coordinator") {
    if (slot.unread > 0) {
      return baseWakeAction(slot, {
        action: "coordinator_inbox",
        reason: "coordinator_unread",
        notify: true,
        safe_to_assign: false,
        prompt: "Read the coordinator inbox, verify reported commits with focused tests, then integrate only known focus-slot commits."
      });
    }
    if (heartbeatProblem) {
      return baseWakeAction(slot, {
        action: "coordinator_heartbeat_due",
        reason: heartbeatProblem,
        safe_to_assign: false
      });
    }
    return baseWakeAction(slot, {
      action: "ok",
      reason: "",
      safe_to_assign: false
    });
  }

  if (slot.status === "paused" || slot.status === "parked") {
    return baseWakeAction(slot, {
      action: "parked",
      reason: "slot_parked",
      safe_to_assign: false
    });
  }

  if (heartbeatProblem && slot.unread === 0 && (!slot.current_task_id || slot.current_task_status === "integrated" || slot.current_task_status === "done")) {
    return baseWakeAction(slot, {
      action: "idle_stale",
      reason: heartbeatProblem,
      safe_to_assign: false
    });
  }

  if (heartbeatProblem) {
    return baseWakeAction(slot, {
      action: "blocked_restart_required",
      reason: heartbeatProblem,
      notify: true,
      safe_to_assign: false,
      blocked: true
    });
  }

  if (slot.current_task_status === "reported") {
    return baseWakeAction(slot, {
      action: "await_integration",
      reason: "task_reported",
      notify: true,
      safe_to_assign: false
    });
  }

  if (slot.unread > 0) {
    const prompt = buildSlotWakePrompt(slot, options.unread);
    return baseWakeAction(slot, {
      action: "wake_slot",
      reason: slot.current_task_id ? "task_inbox_unread" : "slot_inbox_unread",
      safe_to_assign: false,
      prompt,
      adapter_request: buildAdapterRequest(slot, prompt, options.adapter)
    });
  }

  if (slot.current_task_status === "active") {
    const prompt = buildSlotContinuePrompt(slot);
    return baseWakeAction(slot, {
      action: "continue_task",
      reason: "task_active",
      safe_to_assign: false,
      prompt,
      adapter_request: buildAdapterRequest(slot, prompt, options.adapter)
    });
  }

  return baseWakeAction(slot, {
    action: "idle_healthy",
    reason: "",
    safe_to_assign: true
  });
}

function heartbeatBlocker(slot, options) {
  if (slot.heartbeat_status === "failed" || slot.heartbeat_status === "stale") {
    return `heartbeat_${slot.heartbeat_status}`;
  }
  if (!slot.heartbeat_checked_at) return "heartbeat_missing";
  if (isOlderThan(slot.heartbeat_checked_at, options.heartbeatMaxMs, options.checkedAt)) {
    return "heartbeat_overdue";
  }
  return "";
}

function baseWakeAction(slot, input) {
  return {
    slot: slot.slot,
    action: input.action,
    reason: input.reason || "",
    notify: input.notify === true,
    blocked: input.blocked === true,
    safe_to_assign: input.safe_to_assign === true,
    status: slot.status || "",
    project: slot.project || "",
    focus: slot.focus || "",
    worktree: slot.worktree || "",
    branch: slot.branch || "",
    unread: slot.unread || 0,
    current_task_id: slot.current_task_id || null,
    current_task_status: slot.current_task_status || null,
    heartbeat_status: slot.heartbeat_status || null,
    heartbeat_checked_at: slot.heartbeat_checked_at || null,
    run_id: slot.run_id || null,
    app_server_thread_id: slot.app_server_thread_id || null,
    app_server_url: slot.app_server_url || null,
    prompt: input.prompt || null,
    adapter_request: input.adapter_request || null
  };
}

function buildSlotWakePrompt(slot, unread) {
  const subjects = unread
    .slice(0, 3)
    .map((message) => message.subject || message.type || message.id)
    .filter(Boolean);
  const subjectLine = subjects.length ? `Unread subjects: ${subjects.join("; ")}` : "Unread inbox is waiting.";
  return [
    `Codenator wake for ${slot.slot}.`,
    "Use the auralis-codenator MCP tools; legacy auralis-codextrator aliases are accepted. Do not rely on Desktop automation resume.",
    "First read your inbox with mark_read=false, then call claim_next_task for your slot if a task is assigned.",
    "Work only inside your registered worktree, run focused tests, commit the slice, and report_commit back to coordinator.",
    subjectLine
  ].join("\n");
}

function buildSlotContinuePrompt(slot) {
  return [
    `Continue your active Codenator task for ${slot.slot}.`,
    "Use the auralis-codenator MCP tools for coordination; legacy auralis-codextrator aliases are accepted.",
    "First record_heartbeat for your slot with status ok.",
    "Then inspect your active task/status; do not claim a new task.",
    "Continue only the active task inside your registered worktree.",
    "Run focused tests or checks, commit the slice, and report_commit back to coordinator.",
    "If blocked, update_task with the blocker and stop."
  ].join("\n");
}

function buildAdapterRequest(slot, prompt, adapter) {
  if (adapter !== "codex-app-server") {
    return {
      adapter: "notify-only",
      mode: "dry-run",
      prompt
    };
  }
  if (slot.app_server_thread_id) {
    return {
      adapter: "codex-app-server",
      mode: "ready",
      method: "turn/start",
      app_server_url: slot.app_server_url || null,
      params: {
        threadId: slot.app_server_thread_id,
        input: [{ type: "text", text: prompt }]
      },
      note: "Ready only because the slot has an explicit app-server thread id."
    };
  }
  return {
    adapter: "codex-app-server",
    mode: "dry-run",
    requires: ["app_server_thread_id"],
    method: "turn/start",
    params_template: {
      threadId: "${app_server_thread_id}",
      input: [{ type: "text", text: prompt }]
    },
    note: "Dry-run only until a slot has an explicit app-server thread id."
  };
}

function recordWakeAttempt(store, input) {
  const attempt = {
    id: input.id || makeId("wake"),
    slot: input.slot,
    action: input.action || "wake_slot",
    adapter: input.adapter || "notify-only",
    status: input.status || "planned",
    reason: input.reason || "",
    prompt: input.prompt || null,
    result: input.result || null,
    error: input.error || null,
    created_at: now()
  };
  writeJson(
    path.join(store, "wake", `${safeStamp()}_${safeFileName(attempt.slot)}_${safeFileName(attempt.id)}.json`),
    attempt
  );
  return attempt;
}

function buildStatus(store) {
  const registry = readRegistry(store);
  const tasksById = new Map(listTasks(store).map((task) => [task.task_id, task]));
  const slots = ["coordinator", ...Object.keys(registry.sessions || {}).sort()].map((slot) => {
    const session = slot === "coordinator" ? registry.coordinator : registry.sessions[slot];
    const task = session.current_task_id ? tasksById.get(session.current_task_id) : null;
    return {
      slot,
      identity: session.identity || "",
      project: session.project || "",
      focus: session.focus || "",
      worktree: session.worktree || "",
      branch: session.branch || "",
      status: session.status || "",
      unread: unreadMessages(store, slot).length,
      current_task_id: session.current_task_id || null,
      current_task_status: session.current_task_status || null,
      current_task_assigned_at: task ? task.assigned_at : null,
      current_task_updated_at: task ? task.updated_at : null,
      heartbeat_status: session.heartbeat_status || null,
      heartbeat_checked_at: session.heartbeat_checked_at || null,
      run_id: session.run_id || null,
      app_server_thread_id: session.app_server_thread_id || null,
      app_server_url: session.app_server_url || null,
      thread_id: null
    };
  });
  return {
    registry: {
      version: registry.version,
      name: registry.name,
      transport: "mcp",
      updated_at: registry.updated_at
    },
    slots,
    tasks: listTasks(store)
  };
}

function buildFocusBoardSnapshot(store, input = {}) {
  const viewerSlot = input.viewer_slot || input.slot || "coordinator";
  const board = readFocusBoard(store);
  const status = buildStatus(store);
  const tasks = listTasks(store).map((task) => summarizeTask(task));
  const summaryPause = buildSummaryPausePolicy(store, tasks);
  const assignments = Object.fromEntries(status.slots
    .filter((slot) => slot.slot !== "coordinator")
    .map((slot) => [slot.slot, {
      slot: slot.slot,
      project: slot.project,
      focus: slot.focus,
      branch: slot.branch,
      current_task_id: slot.current_task_id,
      current_task_status: slot.current_task_status,
      unread: slot.unread,
      heartbeat_status: slot.heartbeat_status,
      heartbeat_checked_at: slot.heartbeat_checked_at
    }]));
  const integrationReceipts = tasks
    .filter((task) => task.commit && (task.status === "integrated" || task.status === "done"))
    .map((task) => ({
      task_id: task.task_id,
      slot: task.slot,
      commit: task.commit,
      integrated_at: task.integrated_at,
      milestone_id: task.milestone_id,
      lane_id: task.lane_id
    }));
  const ownTaskIds = viewerSlot === "coordinator"
    ? []
    : tasks
      .filter((task) => task.slot === viewerSlot && task.status !== "integrated" && task.status !== "done")
      .map((task) => task.task_id);

  return {
    version: 1,
    generated_at: now(),
    board: {
      name: board.name,
      description: board.description,
      updated_at: board.updated_at
    },
    visibility: {
      viewer_slot: viewerSlot,
      role: viewerSlot === "coordinator" ? "coordinator" : "worker",
      can_manage_backlog: viewerSlot === "coordinator",
      can_read_all_progress: true,
      can_report_own_work: viewerSlot !== "coordinator",
      own_task_ids: ownTaskIds
    },
    progress: {
      status_counts: countBy(tasks, (task) => task.status || "unknown"),
      total_tasks: tasks.length,
      active_slots: Object.keys(assignments).length,
      summary_pause: summaryPause
    },
    milestones: buildMilestoneSummaries(board, tasks),
    lanes: buildLaneSummaries(board, status, tasks),
    tasks,
    assignments,
    reports: listReports(store),
    integration_receipts: integrationReceipts
  };
}

function summarizeTask(task) {
  return {
    task_id: task.task_id,
    title: task.title,
    subject: task.subject,
    status: task.status,
    slot: task.slot,
    project: task.project,
    branch: task.branch,
    worktree: task.worktree,
    milestone_id: task.milestone_id || null,
    lane_id: task.lane_id || null,
    dependencies: normalizeStringArray(task.dependency_ids),
    acceptance_criteria: normalizeStringArray(task.acceptance_criteria),
    required_receipts: normalizeStringArray(task.required_receipts),
    visible_progress_summary: task.visible_progress_summary || "",
    commit: task.commit || null,
    tests: task.tests || [],
    blockers: task.blockers || [],
    assigned_at: task.assigned_at || null,
    started_at: task.started_at || null,
    reported_at: task.reported_at || null,
    integrated_at: task.integrated_at || null,
    updated_at: task.updated_at || null
  };
}

function buildMilestoneSummaries(board, tasks) {
  const knownMilestones = new Map(board.milestones.map((milestone) => [milestone.milestone_id, milestone]));
  for (const task of tasks) {
    if (task.milestone_id && !knownMilestones.has(task.milestone_id)) {
      knownMilestones.set(task.milestone_id, {
        milestone_id: task.milestone_id,
        title: task.milestone_id,
        status: "implicit",
        description: "",
        order: 0
      });
    }
  }
  return [...knownMilestones.values()]
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || left.milestone_id.localeCompare(right.milestone_id))
    .map((milestone) => {
      const milestoneTasks = tasks.filter((task) => task.milestone_id === milestone.milestone_id);
      return {
        ...milestone,
        task_counts: countBy(milestoneTasks, (task) => task.status || "unknown"),
        task_ids: milestoneTasks.map((task) => task.task_id)
      };
    });
}

function buildLaneSummaries(board, status, tasks) {
  const lanes = new Map(board.lanes.map((lane) => [lane.lane_id, lane]));
  for (const slot of status.slots) {
    if (slot.slot === "coordinator") continue;
    const existing = [...lanes.values()].find((lane) => lane.owner_slot === slot.slot);
    if (!existing) {
      lanes.set(slot.slot, {
        lane_id: slot.slot,
        title: slot.focus || slot.slot,
        owner_slot: slot.slot,
        project: slot.project || "",
        status: slot.status || "active",
        description: "",
        order: 0
      });
    }
  }
  return [...lanes.values()]
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || left.lane_id.localeCompare(right.lane_id))
    .map((lane) => {
      const laneTasks = tasks.filter((task) => task.lane_id === lane.lane_id || (!task.lane_id && task.slot === lane.owner_slot));
      return {
        ...lane,
        task_counts: countBy(laneTasks, (task) => task.status || "unknown"),
        task_ids: laneTasks.map((task) => task.task_id)
      };
    });
}

function countBy(items, fn) {
  return items.reduce((counts, item) => {
    const key = fn(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function listReports(store) {
  const dir = path.join(store, "reports");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "last-reported.json")
    .sort()
    .map((name) => {
      const report = readJson(path.join(dir, name));
      return {
        id: report.id || name,
        slot: report.slot || "",
        sha: report.sha || "",
        branch: report.branch || "",
        subject: report.subject || "",
        changed: report.changed || [],
        worktree: report.worktree || "",
        created_at: report.created_at || null
      };
    });
}

function isOlderThan(value, ageMs, nowValue = Date.now()) {
  const time = Date.parse(value || "");
  if (Number.isNaN(time)) return false;
  const nowMs = typeof nowValue === "number" ? nowValue : Date.parse(nowValue);
  if (Number.isNaN(nowMs)) return false;
  return nowMs - time > ageMs;
}

module.exports = {
  ensureStore,
  storePath,
  resolveStoreRoot,
  registerSlot,
  readInbox,
  upsertMilestone,
  upsertLane,
  buildFocusBoardSnapshot,
  createTask,
  claimNextTask,
  updateTask,
  reportCommit,
  recordHeartbeat,
  buildSummaryPausePolicy,
  recordSummaryPause,
  buildWakePlan,
  recordWakeAttempt,
  buildStatus,
  appendLedger
};
