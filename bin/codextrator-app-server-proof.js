#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }
  runProof(opts).then((result) => {
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    const result = {
      ok: false,
      error: error.stack || error.message
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`codenator-app-server-proof: ${error.message}`);
    process.exitCode = 1;
  });
}

async function runProof(opts) {
  const port = Number(opts.port || 4575);
  const url = opts.url || `ws://127.0.0.1:${port}`;
  const proofRoot = opts.cwd ? path.resolve(opts.cwd) : fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-proof-"));
  const timeoutMs = Number(opts["timeout-ms"] || 120000);
  const effort = opts.effort || "low";
  const evidence = {
    proofRoot,
    url,
    started_at: new Date().toISOString(),
    command: `codex app-server --listen ${url}`,
    events: [],
    responses: {},
    agent_text: "",
    stderr_tail: []
  };

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", evidence.command], {
    cwd: proofRoot,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  evidence.child_pid = child.pid;
  child.stderr.on("data", (chunk) => pushTail(evidence.stderr_tail, chunk.toString(), 24));
  child.on("exit", (code, signal) => {
    evidence.child_exit = { code, signal, at: new Date().toISOString() };
  });

  let ws;
  try {
    ws = await connectWithRetry(url, 20000);
    const client = makeClient(ws, evidence);
    evidence.initialize = await client.request("initialize", {
      clientInfo: {
        name: "auralis-codenator-proof",
        title: "Auralis Codenator Proof",
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
  } catch (error) {
    evidence.error = error.stack || error.message;
    evidence.finished_at = new Date().toISOString();
    return { ok: false, reason: "proof_error", evidence };
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

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return { opts };
}

function printHuman(result) {
  console.log(`Codenator app-server proof: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`reason=${result.reason}`);
  const evidence = result.evidence || {};
  if (evidence.thread_id) console.log(`thread=${evidence.thread_id}`);
  if (evidence.turn_id) console.log(`turn=${evidence.turn_id}`);
  if (evidence.agent_text) console.log(`agent=${evidence.agent_text}`);
  if (evidence.error) console.log(`error=${evidence.error}`);
}

function printHelp() {
  console.log(`codenator-app-server-proof

Usage:
  codenator-app-server-proof [--json] [--port N] [--effort low|medium|high]
                               [--timeout-ms N] [--prompt TEXT]

Legacy alias:
  codextrator-app-server-proof [--json] [--port N] [--effort low|medium|high]
                               [--timeout-ms N] [--prompt TEXT]

Starts a loopback Codex app-server, opens an ephemeral read-only test thread,
delivers a harmless turn/start, waits for turn/completed, and kills the process
tree. Defaults to effort=low because effort=minimal is incompatible with some
tool configurations.
`);
}

main();
