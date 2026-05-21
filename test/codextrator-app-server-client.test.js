"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const {
  decideCommandApprovalResponse,
  decideMcpElicitationResponse,
  hasJsonRpcId,
  startPersistentThread
} = require("../src/app-server-client.js");

assert.strictEqual(typeof startPersistentThread, "function");

const heartbeatApproval = {
  threadId: "thread-session-04",
  turnId: "turn-session-04",
  serverName: "auralis-codextrator",
  mode: "form",
  message: "Allow the auralis-codextrator MCP server to run tool \"record_heartbeat\"?",
  meta: {
    codex_approval_kind: "mcp_tool_call"
  },
  requestedSchema: {
    type: "object"
  }
};

let decision = decideMcpElicitationResponse(heartbeatApproval, {
  approveCodextratorMcp: true
});
assert.deepStrictEqual(decision, {
  action: "accept",
  content: {}
});

decision = decideMcpElicitationResponse({
  ...heartbeatApproval,
  message: "Allow the auralis-codextrator MCP server to run tool \"get_focus_board\"?"
}, {
  approveCodextratorMcp: true
});
assert.deepStrictEqual(decision, {
  action: "accept",
  content: {}
});

decision = decideMcpElicitationResponse({
  ...heartbeatApproval,
  message: "Allow the auralis-codextrator MCP server to run tool \"unknown_tool\"?"
}, {
  approveCodextratorMcp: true
});
assert.strictEqual(decision, null);

decision = decideMcpElicitationResponse({
  ...heartbeatApproval,
  serverName: "not-codextrator",
  message: "Allow the not-codextrator MCP server to run tool \"record_heartbeat\"?"
}, {
  approveCodextratorMcp: true
});
assert.strictEqual(decision, null);

decision = decideMcpElicitationResponse(heartbeatApproval, {
  approveCodextratorMcp: false
});
assert.strictEqual(decision, null);

decision = decideMcpElicitationResponse({
  ...heartbeatApproval,
  meta: {
    codex_approval_kind: "other"
  }
}, {
  approveCodextratorMcp: true
});
assert.strictEqual(decision, null);

assert.strictEqual(hasJsonRpcId({ id: 0, method: "mcpServer/elicitation/request" }), true);
assert.strictEqual(hasJsonRpcId({ id: 12, method: "mcpServer/elicitation/request" }), true);
assert.strictEqual(hasJsonRpcId({ method: "turn/completed" }), false);

const worktree = path.join(os.tmpdir(), "codextrator-worktrees", "demo-project", "process-orchestration");
const commandApproval = {
  threadId: "thread-session-02",
  turnId: "turn-session-02",
  itemId: "call-safe-git",
  cwd: worktree,
  availableDecisions: ["accept", "decline"]
};

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "git diff --check"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "git add -- docs/focus-slot/reports/process-orchestration.md"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "-Command",
    "git add -- docs\\focus-slot\\reports\\process-orchestration.md"
  ]
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'git add docs/focus-slot/reports/process-orchestration.md'"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "-Command",
    "git ls-files docs/interfaces prototypes"
  ]
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "git rev-parse 313335f:docs/interfaces/cortex-context-receipt-bundle-v1.md"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'git hash-object --no-filters -- docs/interfaces/cortex-context-receipt-bundle-v1.md prototypes/context-receipt-bundle/context-receipt-bundle.test.js'"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "git clean -fd -- docs/interfaces/cortex-context-receipt-bundle-v1.md prototypes/context-receipt-bundle"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "-Command",
    "Get-ChildItem -Recurse -File docs,prototypes | ForEach-Object { $_.FullName.Substring($PWD.Path.Length + 1) }"
  ]
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "node prototypes/context-engine/test-context-engine.js"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "node --check prototypes/context-engine/index.js"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: ["git", "commit", "-m", "docs: record daemon loop proof"]
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "accept" });

decision = decideCommandApprovalResponse({
  ...commandApproval,
  command: "git diff --check"
}, {
  approveSafeCommands: false,
  commandApprovalCwd: worktree
});
assert.strictEqual(decision, null);

decision = decideCommandApprovalResponse({
  ...commandApproval,
  cwd: path.join(os.tmpdir(), "codextrator-projects", "other-project"),
  command: "git diff --check"
}, {
  approveSafeCommands: true,
  commandApprovalCwd: worktree
});
assert.deepStrictEqual(decision, { decision: "decline" });

for (const unsafeCommand of [
  "git add -- .",
  "git reset --hard",
  "git push origin main",
  "git commit -am unsafe",
  "git clean -fdx -- docs/interfaces",
  "git clean -fd -- .",
  "git rev-parse --verify HEAD",
  "git hash-object E:/01-AURALIS/projects/auralis-cortex/file.js",
  "git diff --check && git push",
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "node ../outside.js",
  "Get-ChildItem -Recurse -File ..",
  "Get-ChildItem -Recurse -File docs | Remove-Item"
]) {
  decision = decideCommandApprovalResponse({
    ...commandApproval,
    command: unsafeCommand
  }, {
    approveSafeCommands: true,
    commandApprovalCwd: worktree
  });
  assert.deepStrictEqual(decision, { decision: "decline" });
}

console.log("codextrator-app-server-client.test.js: PASS");
