"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const CODEXTRATOR_MCP_SERVER = "auralis-codextrator";
const CODEXTRATOR_MCP_TOOLS = new Set([
  "claim_next_task",
  "get_focus_board",
  "get_status",
  "read_inbox",
  "record_heartbeat",
  "report_commit",
  "update_task"
]);

function makeAppServerUrl(port) {
  return `ws://127.0.0.1:${Number(port || 4575)}`;
}

async function runProof(opts = {}) {
  const port = Number(opts.port || 4575);
  const url = opts.url || makeAppServerUrl(port);
  const proofRoot = opts.cwd ? path.resolve(opts.cwd) : fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-proof-"));
  const timeoutMs = Number(opts["timeout-ms"] || opts.timeoutMs || 120000);
  const effort = opts.effort || "low";
  const evidence = makeEvidence({
    cwd: proofRoot,
    url,
    command: `codex app-server --listen ${url}`
  });

  return withAppServer({
    url,
    cwd: proofRoot,
    evidence,
    connectTimeoutMs: Number(opts.connectTimeoutMs || 20000)
  }, async ({ client }) => {
    evidence.initialize = await client.request("initialize", {
      clientInfo: {
        name: "auralis-codextrator-proof",
        title: "Auralis Codextrator Proof",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    }, 15000);

    const threadStart = await client.request("thread/start", {
      cwd: proofRoot,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      sessionStartSource: "clear",
      baseInstructions: "Harmless connectivity proof. Do not inspect or modify files. Reply briefly only."
    }, 30000);

    const threadId = threadStart.thread.id;
    evidence.thread_id = threadId;
    const turnStart = await client.request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: opts.prompt || "Harmless app-server proof. Reply exactly: APP_SERVER_WAKE_OK.",
        text_elements: []
      }],
      cwd: proofRoot,
      approvalPolicy: "never",
      effort
    }, 30000);

    evidence.turn_id = turnStart.turn.id;
    evidence.turn_started_status = turnStart.turn.status;
    const completed = await client.waitCompleted(threadId, timeoutMs, evidence.turn_id);
    evidence.completed = completed;
    evidence.finished_at = new Date().toISOString();
    const turnCompleted = completed.params && completed.params.turnStatus === "completed";
    const expectedText = opts.expected || "APP_SERVER_WAKE_OK";
    const textMatched = evidence.agent_text.includes(expectedText);
    return {
      ok: turnCompleted && textMatched,
      reason: turnCompleted ? (textMatched ? "app_server_turn_completed" : "expected_text_missing") : "turn_failed",
      evidence
    };
  }).catch((error) => {
    evidence.error = error.stack || error.message;
    evidence.finished_at = new Date().toISOString();
    return { ok: false, reason: "proof_error", evidence };
  });
}

async function sendTurnToThread(opts = {}) {
  if (!opts.threadId) throw new Error("threadId is required");
  const url = opts.url || makeAppServerUrl(opts.port || 4575);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const timeoutMs = Number(opts["timeout-ms"] || opts.timeoutMs || 120000);
  const evidence = makeEvidence({
    cwd,
    url,
    command: `codex app-server --listen ${url}`
  });
  evidence.thread_id = opts.threadId;
  evidence.client_options = {
    approveCodextratorMcp: opts.approveCodextratorMcp === true,
    approveSafeCommands: opts.approveSafeCommands === true,
    commandApprovalCwd: opts.commandApprovalCwd
      ? path.resolve(opts.commandApprovalCwd)
      : (opts.turnCwd ? path.resolve(opts.turnCwd) : cwd)
  };

  try {
    return await withAppServer({
      url,
      cwd,
      evidence,
      connectTimeoutMs: Number(opts.connectTimeoutMs || 20000)
    }, async ({ client }) => {
      evidence.initialize = await client.request("initialize", {
        clientInfo: {
          name: "auralis-codextrator-wake-adapter",
          title: "Auralis Codextrator Wake Adapter",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      }, 15000);

      evidence.resume = await client.request("thread/resume", {
        threadId: opts.threadId
      }, 30000);

      const params = {
        threadId: opts.threadId,
        input: [{
          type: "text",
          text: opts.prompt || "",
          text_elements: []
        }]
      };
      if (opts.effort) params.effort = opts.effort;
      if (opts.turnCwd) params.cwd = path.resolve(opts.turnCwd);
      if (opts.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;

      const turnStart = await client.request("turn/start", params, 30000);
      evidence.turn_id = turnStart.turn.id;
      evidence.turn_started_status = turnStart.turn.status;
      const completed = await waitCompletedOrInterrupt(client, opts.threadId, evidence.turn_id, timeoutMs, evidence, opts);
      evidence.completed = completed;
      evidence.finished_at = new Date().toISOString();
      const turnCompleted = completed.params && completed.params.turnStatus === "completed";
      return {
        ok: turnCompleted,
        reason: turnCompleted ? "app_server_turn_completed" : "turn_failed",
        evidence
      };
    });
  } catch (error) {
    evidence.error = error.stack || error.message;
    evidence.finished_at = new Date().toISOString();
    return { ok: false, reason: "app_server_turn_error", evidence };
  }
}

async function startPersistentThread(opts = {}) {
  const url = opts.url || makeAppServerUrl(opts.port || 4575);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const threadCwd = opts.threadCwd ? path.resolve(opts.threadCwd) : cwd;
  const timeoutMs = Number(opts["timeout-ms"] || opts.timeoutMs || 120000);
  const effort = opts.effort || "low";
  const expected = opts.expected || "";
  const evidence = makeEvidence({
    cwd,
    url,
    command: `codex app-server --listen ${url}`
  });
  evidence.thread_options = {
    threadCwd,
    approvalPolicy: opts.approvalPolicy || "never",
    sandbox: opts.sandbox || "workspace-write",
    ephemeral: opts.ephemeral === true
  };

  try {
    return await withAppServer({
      url,
      cwd,
      evidence,
      connectTimeoutMs: Number(opts.connectTimeoutMs || 20000)
    }, async ({ client }) => {
      evidence.initialize = await client.request("initialize", {
        clientInfo: {
          name: "auralis-codextrator-thread-start",
          title: "Auralis Codextrator Thread Start",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      }, 15000);

      const threadStart = await client.request("thread/start", {
        cwd: threadCwd,
        approvalPolicy: opts.approvalPolicy || "never",
        sandbox: opts.sandbox || "workspace-write",
        ephemeral: opts.ephemeral === true,
        sessionStartSource: opts.sessionStartSource || "clear",
        baseInstructions: opts.baseInstructions || "Auralis Codextrator headless focus slot. Use only instructions from the user turn and registered tools."
      }, 30000);

      const threadId = threadStart.thread.id;
      evidence.thread_id = threadId;

      if (opts.prompt) {
        const turnStart = await client.request("turn/start", {
          threadId,
          input: [{
            type: "text",
            text: opts.prompt,
            text_elements: []
          }],
          cwd: threadCwd,
          approvalPolicy: opts.approvalPolicy || "never",
          effort
        }, 30000);
        evidence.turn_id = turnStart.turn.id;
        evidence.turn_started_status = turnStart.turn.status;
        const completed = await waitCompletedOrInterrupt(client, threadId, evidence.turn_id, timeoutMs, evidence, opts);
        evidence.completed = completed;
      }

      evidence.finished_at = new Date().toISOString();
      const turnCompleted = !opts.prompt || (evidence.completed && evidence.completed.params && evidence.completed.params.turnStatus === "completed");
      const textMatched = !expected || evidence.agent_text.includes(expected);
      return {
        ok: turnCompleted && textMatched,
        reason: turnCompleted ? (textMatched ? "app_server_thread_started" : "expected_text_missing") : "turn_failed",
        thread_id: threadId,
        evidence
      };
    });
  } catch (error) {
    evidence.error = error.stack || error.message;
    evidence.finished_at = new Date().toISOString();
    return { ok: false, reason: "app_server_thread_start_error", evidence };
  }
}

function makeEvidence(input) {
  return {
    proofRoot: input.cwd,
    url: input.url,
    started_at: new Date().toISOString(),
    command: input.command,
    events: [],
    responses: {},
    elicitation_responses: [],
    command_approval_responses: [],
    agent_text: "",
    stderr_tail: []
  };
}

async function waitCompletedOrInterrupt(client, threadId, turnId, timeoutMs, evidence, opts = {}) {
  try {
    return await client.waitCompleted(threadId, timeoutMs, turnId);
  } catch (error) {
    evidence.timeout_error = error.message;
    if (turnId && opts.interruptOnTimeout !== false) {
      try {
        evidence.interrupt = await client.request("turn/interrupt", {
          threadId,
          turnId
        }, Number(opts.interruptTimeoutMs || 15000));
      } catch (interruptError) {
        evidence.interrupt_error = interruptError.stack || interruptError.message;
      }
    }
    throw error;
  }
}

async function withAppServer(input, callback) {
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", input.evidence.command], {
    cwd: input.cwd,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  input.evidence.child_pid = child.pid;
  child.stderr.on("data", (chunk) => pushTail(input.evidence.stderr_tail, chunk.toString(), 24));
  child.on("exit", (code, signal) => {
    input.evidence.child_exit = { code, signal, at: new Date().toISOString() };
  });

  let ws;
  try {
    ws = await connectWithRetry(input.url, input.connectTimeoutMs || 20000);
    const client = makeClient(ws, input.evidence);
    return await callback({ client, evidence: input.evidence, child });
  } finally {
    try {
      if (ws) ws.close();
    } catch {
      // ignore
    }
    if (child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  }
}

async function connectWithRetry(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("connect timeout")), 1000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("websocket error"));
        }, { once: true });
      });
      return ws;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("Could not connect to app-server");
}

function makeClient(ws, evidence) {
  let nextId = 1;
  const pending = new Map();
  const opts = evidence.client_options || {};
  const commandItems = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method) {
      if (message.method === "item/agentMessage/delta" && message.params && message.params.delta) {
        evidence.agent_text += message.params.delta;
      }
      if (message.method === "item/started" && message.params && message.params.item && message.params.item.type === "commandExecution") {
        commandItems.set(message.params.item.id, message.params.item);
      }
      evidence.events.push({
        at: new Date().toISOString(),
        id: hasJsonRpcId(message) ? message.id : null,
        method: message.method,
        params: summarizeParams(message.method, message.params)
      });
      if (message.method === "mcpServer/elicitation/request" && hasJsonRpcId(message)) {
        const response = decideMcpElicitationResponse(message.params, opts);
        evidence.elicitation_responses.push({
          at: new Date().toISOString(),
          id: message.id,
          method: message.method,
          decision: response ? response.action : "unhandled",
          params: summarizeParams(message.method, message.params)
        });
        if (response) ws.send(JSON.stringify({ id: message.id, result: response }));
      }
      if (message.method === "item/commandExecution/requestApproval" && hasJsonRpcId(message)) {
        const params = enrichCommandApprovalParams(message.params, commandItems);
        const response = decideCommandApprovalResponse(params, opts);
        evidence.command_approval_responses.push({
          at: new Date().toISOString(),
          id: message.id,
          method: message.method,
          decision: response ? response.decision : "unhandled",
          params: summarizeParams(message.method, params)
        });
        if (response) ws.send(JSON.stringify({ id: message.id, result: response }));
      }
    }
    if (hasJsonRpcId(message) && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      evidence.responses[item.method] = message.error
        ? { error: message.error }
        : summarizeParams(item.method, message.result);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
  });

  return {
    request(method, params, timeoutMs = 30000) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
    waitCompleted(threadId, timeoutMs, turnId = null) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const found = evidence.events.find((item) => (
            item.method === "turn/completed" &&
            item.params &&
            item.params.threadId === threadId &&
            (!turnId || item.params.turnId === turnId)
          ));
          if (found) {
            clearInterval(interval);
            resolve(found);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(interval);
            reject(new Error("turn/completed timeout"));
          }
        }, 250);
      });
    }
  };
}

function summarizeParams(method, params) {
  if (!params || typeof params !== "object") return params || null;
  if (method === "mcpServer/elicitation/request") {
    const toolApproval = parseMcpToolApproval(params);
    return {
      threadId: params.threadId || null,
      turnId: params.turnId || null,
      serverName: params.serverName || null,
      mode: params.mode || null,
      message: params.message || null,
      url: params.url || null,
      meta: params.meta || params._meta || null,
      tool: toolApproval ? toolApproval.tool : null
    };
  }
  if (method === "item/commandExecution/requestApproval") {
    const commandApproval = parseCommandApproval(params);
    return {
      threadId: params.threadId || null,
      turnId: params.turnId || null,
      itemId: params.itemId || null,
      approvalId: params.approvalId || null,
      reason: params.reason || null,
      cwd: params.cwd || null,
      command: commandApproval ? commandApproval.argv : null,
      commandActions: params.commandActions || null,
      availableDecisions: params.availableDecisions || null,
      additionalPermissions: params.additionalPermissions || null,
      networkApprovalContext: params.networkApprovalContext || null
    };
  }
  if (params.thread) {
    return {
      threadId: params.thread.id,
      cwd: params.thread.cwd,
      status: params.thread.status
    };
  }
  if (params.threadId && params.turn) {
    return {
      threadId: params.threadId,
      turnId: params.turn.id,
      turnStatus: params.turn.status,
      error: params.turn.error || null
    };
  }
  if (params.threadId && params.status) {
    return {
      threadId: params.threadId,
      status: params.status
    };
  }
  if ((method === "item/started" || method === "item/completed") && params.item) {
    const summary = {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.item.id || null,
      itemType: params.item.type,
      status: params.item.status || null
    };
    if (params.item.type === "agentMessage") summary.text = params.item.text || "";
    if (params.item.type === "commandExecution") {
      summary.command = params.item.command || null;
      summary.cwd = params.item.cwd || null;
      summary.source = params.item.source || null;
      summary.exitCode = params.item.exitCode || null;
      summary.error = params.item.error || null;
    }
    if (params.item.type === "mcpToolCall") {
      summary.server = params.item.server || null;
      summary.tool = params.item.tool || null;
      summary.error = params.item.error || null;
    }
    if (params.item.type === "dynamicToolCall") {
      summary.tool = params.item.tool || null;
      summary.success = params.item.success || null;
      summary.error = params.item.error || null;
    }
    return summary;
  }
  if (params.threadId && params.message) {
    return {
      threadId: params.threadId,
      message: params.message
    };
  }
  if (params.threadId) return { threadId: params.threadId };
  return params;
}

function decideMcpElicitationResponse(params, opts = {}) {
  if (!opts.approveCodextratorMcp) return null;
  const request = parseMcpToolApproval(params);
  if (!request) return null;
  const meta = params && (params.meta || params._meta);
  const approvalKind = meta && (meta.codex_approval_kind || meta.codexApprovalKind);
  if (approvalKind && approvalKind !== "mcp_tool_call") return null;
  if (request.serverName !== CODEXTRATOR_MCP_SERVER) return null;
  if (!CODEXTRATOR_MCP_TOOLS.has(request.tool)) return null;
  return {
    action: "accept",
    content: {}
  };
}

function decideCommandApprovalResponse(params, opts = {}) {
  if (!opts.approveSafeCommands) return null;
  const decline = makeCommandDecision(params, "decline");
  const request = parseCommandApproval(params);
  if (!request || !request.cwd || !request.argv || request.argv.length === 0) return decline;
  if (!decisionAvailable(params, "accept")) return decline;
  const root = opts.commandApprovalCwd || opts.turnCwd || opts.cwd;
  if (!root || !isPathInside(request.cwd, root)) return decline;
  const safeArgv = unwrapCommandArgv(request.argv);
  if (!safeArgv || !isSafeGitCommand(safeArgv)) return decline;
  return { decision: "accept" };
}

function parseMcpToolApproval(params = {}) {
  const message = String(params.message || "");
  const parsed = message.match(/^Allow the ([^"]+?) MCP server to run tool "([^"]+)"\?$/);
  const serverName = params.serverName || (parsed && parsed[1]) || null;
  const tool = params.tool || params.toolName || (parsed && parsed[2]) || null;
  if (!serverName || !tool) return null;
  return { serverName, tool };
}

function parseCommandApproval(params = {}) {
  const argv = normalizeCommandArgv(params.command);
  if (!argv) return null;
  return {
    argv,
    cwd: params.cwd ? path.resolve(String(params.cwd)) : null
  };
}

function enrichCommandApprovalParams(params = {}, commandItems = new Map()) {
  const item = params.itemId ? commandItems.get(params.itemId) : null;
  if (!item) return params || {};
  return {
    command: item.command,
    cwd: item.cwd,
    ...params
  };
}

function normalizeCommandArgv(command) {
  if (Array.isArray(command)) {
    const argv = command.map((item) => String(item));
    return argv.every((item) => item && !/[\r\n]/.test(item)) ? argv : null;
  }
  if (command && Array.isArray(command.argv)) return normalizeCommandArgv(command.argv);
  if (command && Array.isArray(command.args)) return normalizeCommandArgv(command.args);
  if (command && typeof command.command === "string") return normalizeCommandArgv(command.command);
  if (typeof command !== "string") return null;
  return splitCommandLine(command);
}

function splitCommandLine(input) {
  if (!input || /[\r\n`]/.test(input)) return null;
  const argv = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!quote && "|&;<>".includes(char)) return null;
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current) argv.push(current);
  return argv.length > 0 ? argv : null;
}

function isSafeGitCommand(argv) {
  const command = executableName(argv[0]);
  if (command !== "git") return false;
  const subcommand = argv[1];
  if (subcommand === "status") {
    return argv.length >= 3 && argv.slice(2).every((arg) => [
      "--short",
      "-s",
      "--porcelain",
      "--porcelain=v1",
      "--branch",
      "-b"
    ].includes(arg));
  }
  if (subcommand === "diff") {
    if (argv.length === 2) return true;
    if (argv[2] === "--check") {
      if (argv.length === 3) return true;
      return argv[3] === "--" && argv.slice(4).length > 0 && argv.slice(4).every(isSafeRelativePath);
    }
    return argv[2] === "--" && argv.slice(3).length > 0 && argv.slice(3).every(isSafeRelativePath);
  }
  if (subcommand === "add") {
    const paths = argv[2] === "--" ? argv.slice(3) : argv.slice(2);
    return paths.length > 0 && paths.every((item) => !String(item).startsWith("-") && isSafeRelativePath(item));
  }
  if (subcommand === "commit") {
    return argv.length === 4 &&
      ["-m", "--message"].includes(argv[2]) &&
      Boolean(argv[3]) &&
      !/[\r\n]/.test(argv[3]);
  }
  return false;
}

function unwrapCommandArgv(argv) {
  const command = executableName(argv[0]);
  if (command !== "pwsh" && command !== "powershell") return argv;
  if (argv.length !== 3 || !["-command", "-c", "/c"].includes(String(argv[1]).toLowerCase())) return null;
  return normalizeCommandArgv(argv[2]);
}

function executableName(value) {
  const base = path.basename(String(value || "")).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function isSafeRelativePath(value) {
  const item = String(value || "").replace(/\\/g, "/");
  if (!item || item === "." || item === "..") return false;
  if (item.includes("*") || item.includes("?")) return false;
  if (path.isAbsolute(item)) return false;
  if (item.startsWith("../") || item.includes("/../")) return false;
  if (item === ".git" || item.startsWith(".git/") || item.includes("/.git/")) return false;
  return true;
}

function isPathInside(target, root) {
  const normalizedTarget = path.resolve(String(target)).toLowerCase();
  const normalizedRoot = path.resolve(String(root)).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function makeCommandDecision(params, decision) {
  if (decisionAvailable(params, decision)) return { decision };
  if (decision === "decline" && decisionAvailable(params, "cancel")) return { decision: "cancel" };
  return null;
}

function decisionAvailable(params = {}, decision) {
  const available = params.availableDecisions;
  if (!Array.isArray(available) || available.length === 0) return true;
  return available.some((item) => (
    item === decision ||
    (item && typeof item === "object" && (item.decision === decision || item.type === decision || item.name === decision))
  ));
}

function hasJsonRpcId(message = {}) {
  return Object.prototype.hasOwnProperty.call(message, "id") && message.id !== null && message.id !== undefined;
}

function pushTail(list, text, max) {
  list.push(text);
  while (list.length > max) list.shift();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runProof,
  sendTurnToThread,
  startPersistentThread,
  makeAppServerUrl,
  decideCommandApprovalResponse,
  decideMcpElicitationResponse,
  hasJsonRpcId
};
