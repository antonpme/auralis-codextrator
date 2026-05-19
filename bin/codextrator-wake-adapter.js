#!/usr/bin/env node
"use strict";

const path = require("path");
const store = require("../src/store.js");
const { runProof, sendTurnToThread } = require("../src/app-server-client.js");

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    return;
  }

  run(opts).then((result) => {
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    const result = {
      ok: false,
      send: truthy(opts.send) && !truthy(opts["dry-run"]),
      error: error.stack || error.message
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`codextrator-wake-adapter: ${error.message}`);
    process.exitCode = 1;
  });
}

async function run(opts) {
  if (opts["test-thread"]) {
    const proof = await runProof({
      ...opts,
      timeoutMs: opts["timeout-ms"]
    });
    return {
      ok: proof.ok,
      mode: "test-thread",
      proof
    };
  }

  const root = path.resolve(opts.root || process.env.AURALIS_CODEXTRATOR_ROOT || process.cwd());
  const storeDir = store.ensureStore(root, opts.agent || "wake-adapter");
  const send = truthy(opts.send) && !truthy(opts["dry-run"]);
  const plan = store.buildWakePlan(storeDir, {
    adapter: "codex-app-server",
    heartbeat_max_minutes: opts["heartbeat-max-minutes"],
    checked_at: opts["checked-at"]
  });
  const selectedActions = plan.actions
    .filter((action) => action.action === "wake_slot" || action.action === "continue_task")
    .filter((action) => !opts.slot || action.slot === opts.slot)
    .map((action) => withPromptOverride(action, opts.prompt));

  const result = {
    ok: true,
    send,
    root,
    checked_at: plan.checked_at,
    decision: plan.decision,
    safety: plan.safety,
    summary: {
      planned: 0,
      blocked: 0,
      sent: 0,
      failed: 0
    },
    actions: selectedActions,
    attempts: []
  };

  for (const action of selectedActions) {
    const request = action.adapter_request || {};
    const missingThreadId = request.requires && request.requires.includes("app_server_thread_id");

    if (missingThreadId) {
      result.summary.blocked += 1;
      if (send) {
        const attempt = store.recordWakeAttempt(storeDir, {
          slot: action.slot,
          action: action.action,
          adapter: "codex-app-server",
          status: "blocked",
          reason: "missing_app_server_thread_id",
          prompt: action.prompt
        });
        result.attempts.push(attempt);
        result.ok = false;
      }
      continue;
    }

    if (!request.params || !request.params.threadId) {
      result.summary.blocked += 1;
      if (send) {
        const attempt = store.recordWakeAttempt(storeDir, {
          slot: action.slot,
          action: action.action,
          adapter: "codex-app-server",
          status: "blocked",
          reason: "invalid_app_server_request",
          prompt: action.prompt
        });
        result.attempts.push(attempt);
        result.ok = false;
      }
      continue;
    }

    if (!send) {
      result.summary.planned += 1;
      continue;
    }

    const turn = await sendTurnToThread({
      url: opts.url || request.app_server_url || undefined,
      port: opts.port,
      cwd: action.worktree || root,
      turnCwd: action.worktree || undefined,
      threadId: request.params.threadId,
      prompt: action.prompt,
      effort: opts.effort || "xhigh",
      approvalPolicy: opts["approval-policy"],
      timeoutMs: opts["timeout-ms"],
      approveCodextratorMcp: true,
      approveSafeCommands: true,
      commandApprovalCwd: action.worktree || root
    });

    const attempt = store.recordWakeAttempt(storeDir, {
      slot: action.slot,
      action: action.action,
      adapter: "codex-app-server",
      status: turn.ok ? "completed" : "failed",
      reason: turn.reason,
      prompt: action.prompt,
      result: turn.evidence ? summarizeTurnEvidence(turn.evidence) : null,
      error: turn.ok ? null : (turn.evidence && turn.evidence.error) || turn.reason
    });
    result.attempts.push(attempt);

    if (turn.ok) result.summary.sent += 1;
    else {
      result.summary.failed += 1;
      result.ok = false;
    }
  }

  if (send && (result.summary.blocked > 0 || result.summary.failed > 0)) {
    result.ok = false;
  }
  return result;
}

function summarizeTurnEvidence(evidence = {}) {
  return {
    thread_id: evidence.thread_id || null,
    turn_id: evidence.turn_id || null,
    url: evidence.url || null,
    finished_at: evidence.finished_at || null,
    agent_text_tail: evidence.agent_text ? evidence.agent_text.slice(-500) : "",
    timeout_error: evidence.timeout_error || null,
    interrupt: evidence.interrupt || null,
    interrupt_error: evidence.interrupt_error || null,
    elicitation_responses_tail: Array.isArray(evidence.elicitation_responses) ? evidence.elicitation_responses.slice(-6) : [],
    command_approval_responses_tail: Array.isArray(evidence.command_approval_responses) ? evidence.command_approval_responses.slice(-6) : [],
    events_tail: Array.isArray(evidence.events) ? evidence.events.slice(-12) : [],
    stderr_tail: Array.isArray(evidence.stderr_tail) ? evidence.stderr_tail.slice(-6) : []
  };
}

function withPromptOverride(action, prompt) {
  if (!prompt) return action;
  const updated = {
    ...action,
    prompt
  };
  if (action.adapter_request && action.adapter_request.params) {
    updated.adapter_request = {
      ...action.adapter_request,
      params: {
        ...action.adapter_request.params,
        input: [{ type: "text", text: prompt }]
      }
    };
  } else if (action.adapter_request && action.adapter_request.params_template) {
    updated.adapter_request = {
      ...action.adapter_request,
      params_template: {
        ...action.adapter_request.params_template,
        input: [{ type: "text", text: prompt }]
      }
    };
  }
  return updated;
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
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
  if (result.mode === "test-thread") {
    const proof = result.proof || {};
    console.log(`Codextrator wake adapter test-thread: ${proof.ok ? "PASS" : "FAIL"}`);
    console.log(`reason=${proof.reason}`);
    return;
  }
  console.log(`Codextrator wake adapter: ${result.ok ? "OK" : "BLOCKED"}`);
  console.log(`send=${result.send} planned=${result.summary.planned} sent=${result.summary.sent} blocked=${result.summary.blocked} failed=${result.summary.failed}`);
  for (const action of result.actions) {
    console.log(`${action.slot.padEnd(12)} ${action.reason} ${action.adapter_request && action.adapter_request.mode}`);
  }
}

function printHelp() {
  console.log(`codextrator-wake-adapter

Usage:
  codextrator-wake-adapter [--root PATH] [--json] [--slot session-01]
                           [--dry-run] [--send] [--port N] [--url WS_URL]
                           [--effort low|medium|high|xhigh]
                           [--heartbeat-max-minutes N]

Default mode is dry-run. It plans codex-app-server wake requests from the MCP
ledger but does not send a turn unless --send is present. A slot is sendable
only after register_slot stores an explicit app_server_thread_id.

Proof mode:
  codextrator-wake-adapter --test-thread --json
`);
}

main();
