"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

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
    const completed = await client.waitCompleted(threadId, timeoutMs);
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
      const completed = await client.waitCompleted(opts.threadId, timeoutMs);
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

function makeEvidence(input) {
  return {
    proofRoot: input.cwd,
    url: input.url,
    started_at: new Date().toISOString(),
    command: input.command,
    events: [],
    responses: {},
    agent_text: "",
    stderr_tail: []
  };
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
      evidence.events.push({
        at: new Date().toISOString(),
        method: message.method,
        params: summarizeParams(message.method, message.params)
      });
    }
    if (message.id && pending.has(message.id)) {
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
    waitCompleted(threadId, timeoutMs) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const found = evidence.events.find((item) => (
            item.method === "turn/completed" &&
            item.params &&
            item.params.threadId === threadId
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
  if (method === "item/completed" && params.item) {
    const summary = {
      threadId: params.threadId,
      turnId: params.turnId,
      itemType: params.item.type
    };
    if (params.item.type === "agentMessage") summary.text = params.item.text || "";
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
  makeAppServerUrl
};
