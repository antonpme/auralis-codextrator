#!/usr/bin/env node
"use strict";

const path = require("path");
const { createRequire } = require("module");
const store = require("./store.js");

function requireMcp(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    const siblingRequire = createRequire(path.resolve(
      __dirname,
      "..",
      "..",
      "auralis-consilium",
      "package.json"
    ));
    return siblingRequire(modulePath);
  }
}

const { Server } = requireMcp("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = requireMcp("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = requireMcp("@modelcontextprotocol/sdk/types.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    root: process.env.AURALIS_CODEXTRATOR_ROOT || process.cwd(),
    agent: process.env.AURALIS_CODEXTRATOR_AGENT || "coordinator"
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root") config.root = args[++i];
    else if (args[i] === "--agent") config.agent = args[++i];
  }
  return config;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function tools() {
  return [
    {
      name: "get_status",
      description: "Read Codextrator slot, unread inbox, heartbeat, and task state without resuming Codex Desktop threads.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "register_slot",
      description: "Register or refresh a Codex focus slot. The slot is stable; run_id is optional and replaces Desktop thread identity.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          project: { type: "string" },
          identity: { type: "string" },
          focus: { type: "string" },
          worktree: { type: "string" },
          branch: { type: "string" },
          status: { type: "string" },
          run_id: { type: "string" }
        },
        required: ["slot", "project", "focus", "worktree"]
      }
    },
    {
      name: "send_message",
      description: "Append a durable message to the Codextrator ledger. Recipients read it through cursor-based inboxes.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          from: { type: "string" },
          type: { type: "string" },
          subject: { type: "string" },
          message: { type: "string" },
          task_id: { type: "string" },
          payload: { type: "object" }
        },
        required: ["to", "message"]
      }
    },
    {
      name: "read_inbox",
      description: "Read unread messages for a slot using a durable cursor. Does not rename or delete inbox files.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          mark_read: { type: "boolean" }
        },
        required: ["slot"]
      }
    },
    {
      name: "create_task",
      description: "Create a queued task for a slot and deliver a task.assign message through the MCP ledger.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          task_id: { type: "string" },
          title: { type: "string" },
          subject: { type: "string" },
          message: { type: "string" },
          project: { type: "string" },
          branch: { type: "string" },
          worktree: { type: "string" }
        },
        required: ["slot", "title", "message"]
      }
    },
    {
      name: "claim_next_task",
      description: "Claim the next queued task for a slot. This marks the task active and advances the slot inbox cursor.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" }
        },
        required: ["slot"]
      }
    },
    {
      name: "update_task",
      description: "Update a task status, commit, tests, or blocker. Integrated/done tasks clear the slot current task pointer.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          status: { type: "string" },
          commit: { type: "string" },
          blocker: { type: "string" },
          tests: { type: "array", items: { type: "string" } }
        },
        required: ["task_id"]
      }
    },
    {
      name: "report_commit",
      description: "Report a focus-slot commit to the coordinator. Metadata can be supplied directly or detected from worktree.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          worktree: { type: "string" },
          sha: { type: "string" },
          branch: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          changed: { type: "array", items: { type: "string" } }
        },
        required: ["slot"]
      }
    },
    {
      name: "record_heartbeat",
      description: "Record slot health for the current live run. Uses run_id, not Codex Desktop target_thread_id.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          status: { type: "string", enum: ["ok", "failed", "stale"] },
          run_id: { type: "string" },
          error: { type: "string" }
        },
        required: ["slot"]
      }
    },
    {
      name: "plan_wake",
      description: "Build a safe notify-only or dry-run wake plan from the MCP ledger without mutating sessions, tasks, or inbox cursors.",
      inputSchema: {
        type: "object",
        properties: {
          adapter: { type: "string", enum: ["notify-only", "codex-app-server"] },
          heartbeat_max_minutes: { type: "number" },
          checked_at: { type: "string" }
        }
      }
    },
    {
      name: "record_wake_attempt",
      description: "Persist the result of a planned wake attempt for audit/proof without changing task or inbox state.",
      inputSchema: {
        type: "object",
        properties: {
          slot: { type: "string" },
          action: { type: "string" },
          adapter: { type: "string" },
          status: { type: "string" },
          reason: { type: "string" },
          prompt: { type: "string" },
          result: { type: "object" },
          error: { type: "string" }
        },
        required: ["slot"]
      }
    }
  ];
}

async function main() {
  const config = parseArgs();
  const storeDir = store.ensureStore(config.root, config.agent);
  const log = (...items) => process.stderr.write(`${items.join(" ")}\n`);
  log(`[auralis-codextrator] MCP starting: agent=${config.agent}`);
  log(`[auralis-codextrator] Root: ${path.resolve(config.root)}`);

  const mcp = new Server(
    { name: "auralis-codextrator", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "auralis-codextrator coordinates Codex focus slots through MCP.",
        "Use cursor-based inboxes and durable task state. Do not depend on Codex Desktop automation resume.",
        "Stable slot ids identify focus lanes; optional run_id identifies the currently live Codex session.",
        `This agent: ${config.agent}.`
      ].join("\n")
    }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    try {
      switch (name) {
        case "get_status":
          return ok(store.buildStatus(storeDir));
        case "register_slot":
          return ok({ slot: store.registerSlot(storeDir, args) });
        case "send_message":
          return ok({
            message: store.appendLedger(storeDir, {
              ...args,
              from: args.from || config.agent
            })
          });
        case "read_inbox":
          {
            const messages = store.readInbox(storeDir, args.slot, {
              markRead: args.mark_read !== false
            });
            return ok({
              slot: args.slot,
              unread_count: messages.length,
              messages
            });
          }
        case "create_task":
          return ok(store.createTask(storeDir, {
            ...args,
            created_by: args.created_by || config.agent
          }));
        case "claim_next_task":
          return ok(store.claimNextTask(storeDir, args.slot));
        case "update_task":
          return ok({ task: store.updateTask(storeDir, args.task_id, args) });
        case "report_commit":
          return ok(store.reportCommit(storeDir, args));
        case "record_heartbeat":
          return ok({ heartbeat: store.recordHeartbeat(storeDir, args) });
        case "plan_wake":
          return ok(store.buildWakePlan(storeDir, args));
        case "record_wake_attempt":
          return ok({ attempt: store.recordWakeAttempt(storeDir, args) });
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return err(error.message);
    }
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[auralis-codextrator] Fatal: ${error.stack || error.message}\n`);
  process.exit(1);
});
