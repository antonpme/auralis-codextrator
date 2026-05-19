# auralis-codextrator

Parallel session orchestration for Codex Desktop.

`auralis-codextrator` is a small local utility for coordinating multiple
focused Codex Desktop sessions across projects, worktrees, inboxes, hooks, and
commit reports.

It is intentionally not an agent identity system. A session slot such as
`session-01` is only a technical focus slot. Identity, project, focus, worktree,
and branch live in the registry metadata.

## MVP Features

- Local registry of focus sessions.
- Per-session inboxes.
- Lightweight direct messages.
- Durable task records.
- Slot registry view with current task and heartbeat state.
- Structured message ledger.
- Heartbeat health records and recovery summary.
- Commit reports.
- Status view with unread counts.
- Codex hook entrypoint for post-tool commit detection.
- No cloud dependency.
- No runtime dependency beyond Node.js.

## MCP Mode

Codextrator now has an MCP server that uses the same local store without relying
on Codex Desktop automations or `target_thread_id` resume.

Run it with:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\src\server.js `
  --root E:\01-AURALIS `
  --agent elian
```

Suggested Codex MCP config:

```toml
[mcp_servers.auralis-codextrator]
command = "node"
args = ["E:/01-AURALIS/tools/auralis-codextrator/src/server.js", "--root", "E:/01-AURALIS", "--agent", "elian"]
```

MCP tools:

- `get_status`: read slots, unread cursor counts, heartbeat, and task state.
- `register_slot`: create or refresh a stable focus slot. It can also store an
  explicit `app_server_thread_id` for a Codex app-server wake adapter.
- `send_message`: append a durable ledger message.
- `read_inbox`: read unread messages through a cursor without deleting files.
- `create_task`: queue a task and deliver a `task.assign` message.
- `claim_next_task`: claim the next queued task and mark it active.
- `update_task`: update status, commit, tests, or blockers.
- `report_commit`: report a focus-slot commit to the coordinator.
- `record_heartbeat`: record live-run health with `run_id`, not Desktop thread id.
- `plan_wake`: build a safe MCP-ledger wake plan without mutating inboxes,
  tasks, or Codex Desktop threads.
- `record_wake_attempt`: persist notify-only or adapter wake proof records.

Design boundary: Codex automations should not be the primary transport for
focus-slot work. If used later, they should only act as an external watchdog.
Actual coordination should happen through the MCP inbox/task/report tools.

### Wake Watcher Proof

`plan_wake` is the first external-watch primitive. It reads only MCP registry,
cursor inbox, task, and heartbeat state, then returns one of:

- `DONT_NOTIFY`: nothing actionable is waiting.
- `NOTIFY`: coordinator attention or recovery is needed.
- `WAKE`: one or more healthy slots have unread work and should be nudged by an
  external adapter.

The tool is deliberately non-mutating. It does not claim tasks, clear inboxes,
start Desktop automations, or create Codex app-server turns. With
`adapter: "codex-app-server"` it returns a ready `turn/start` request only for a
slot that has an explicit `app_server_thread_id`; otherwise it stays in dry-run
mode and marks the missing requirement instead of guessing a thread id.

After an external helper performs a notify-only or app-server wake attempt, it
can call `record_wake_attempt` to write an audit record under `wake/`.

For local schedulers or a standalone daemon, use the CLI wrapper:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator-mcp-watch.js `
  --root E:\01-AURALIS `
  --json
```

If a legacy CLI store exists at `ROOT\.auralis-codextrator` and a current MCP v2
store exists at `ROOT\.codextrator-mcp-root\.auralis-codextrator`, the watch
wrapper selects the MCP v2 root. This avoids replaying stale legacy inbox state
as active work.

### App-Server Proof

Use the app-server proof command before enabling a wake adapter that talks to
real focus slots:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator-app-server-proof.js `
  --json
```

The proof starts `codex app-server --listen ws://127.0.0.1:PORT`, connects over
WebSocket, calls `initialize`, creates an ephemeral read-only test thread, sends
a harmless `turn/start`, waits for `turn/completed`, verifies the final text,
and then kills the app-server process tree. It defaults to `effort=low`; on this
host `effort=minimal` failed because the current tool configuration included
tools that are incompatible with minimal reasoning.

### App-Server Wake Adapter

The wake adapter is the first guarded sender. It reads the same MCP wake plan,
but defaults to dry-run and will not send a `turn/start` unless `--send` is
present and the target slot already has an explicit `app_server_thread_id`.

Dry-run:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator-wake-adapter.js `
  --root E:\01-AURALIS `
  --json `
  --dry-run
```

Send mode:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator-wake-adapter.js `
  --root E:\01-AURALIS `
  --slot session-01 `
  --json `
  --send
```

If a send is attempted without a registered app-server thread id, the adapter
records a blocked wake attempt under `wake/` with
`reason=missing_app_server_thread_id` and exits non-zero. Dry-run mode does not
write wake attempts.

For a harmless loopback proof through a temporary read-only thread:

```powershell
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator-wake-adapter.js `
  --test-thread `
  --json `
  --effort low
```

## Quick Start

Initialize a shared store:

```powershell
node .\bin\codextrator.js init --root C:\workspace
```

Register a session slot:

```powershell
node .\bin\codextrator.js register session-01 `
  --project demo-project `
  --identity developer `
  --focus "Feature A" `
  --worktree C:\workspace\demo-project-feature-a `
  --branch feature/demo-a
```

Send a message:

```powershell
node .\bin\codextrator.js send coordinator `
  --from session-01 `
  --subject "Feature A ready" `
  --message "Committed the first draft for review."
```

Read inbox:

```powershell
node .\bin\codextrator.js inbox coordinator
```

Assign a structured task:

```powershell
node .\bin\codextrator.js task-create session-01 `
  --task-id session-01-round-1 `
  --title "Round 1: focused slice" `
  --message "Work only in the assigned files, test, commit, and report."
```

List tasks and slots:

```powershell
node .\bin\codextrator.js task-list
node .\bin\codextrator.js slots
```

Import already-queued inbox messages into task records without sending
duplicates:

```powershell
node .\bin\codextrator.js task-import-inbox session-01
```

Record heartbeat health:

```powershell
node .\bin\codextrator.js heartbeat session-01 `
  --status ok `
  --automation-id auralis-codextrator-session-01
```

Show recovery recommendations:

```powershell
node .\bin\codextrator.js recovery
```

Run a quiet watchdog check that does not create Codex sessions and does not
mutate inboxes, tasks, or focus-slot state:

```powershell
node .\bin\codextrator.js watchdog-check --json
```

`watchdog-check` reads coordinator inbox, recovery, and heartbeat health, then
returns `NOTIFY` or `DONT_NOTIFY`. It records only watchdog state under
`watchdog/` so repeated alerts can be snoozed without clearing real work.
Use this from an OS scheduler or a long-running local helper instead of a
frequent Codex cron automation when sidebar noise matters.

Example quiet local check:

```powershell
$env:AURALIS_CODEXTRATOR_ROOT = "E:\01-AURALIS"
node E:\01-AURALIS\tools\auralis-codextrator\bin\codextrator.js watchdog-check `
  --json `
  --snooze-minutes 20
```

This command is intentionally not an actor. It should never perform
integration, task assignment, inbox clearing, or Desktop thread creation.

Show status:

```powershell
node .\bin\codextrator.js status
```

Submit a commit report from the current worktree:

```powershell
node C:\tools\auralis-codextrator\bin\codextrator.js report-commit
```

## Codex Hooks

Codex hooks can call deterministic commands on lifecycle events. The MVP
provides a `hook-post-tool-use` entrypoint that inspects hook input and submits a
commit report when it sees a git commit command.

Print a hook template:

```powershell
node .\bin\codextrator.js hook-template
```

Then place the output in a workspace `.codex/hooks.json`, or adapt it to your
global Codex config.

## Store Layout

```text
.auralis-codextrator/
  registry.json
  inbox/
    coordinator/
    session-01/
  archive/
  heartbeat/
  messages/
  reports/
  tasks/
  hooks/
```

## Design Notes

- Keep session slots generic: `session-01`, `session-02`, etc.
- Use registry metadata for project/focus/worktree/branch.
- Keep identity separate from focus.
- Use hooks for automatic reports, not for hidden work.
- Treat inbox messages as wake/notification surfaces; task records are the
  durable work state.
- Treat heartbeat health as operational state; a failed or stale heartbeat
  means the slot thread may need a fresh Desktop session.
- Treat old queued unread tasks without heartbeat health as recovery blockers,
  not as healthy idle state. Current CLI recovery flags queued unread work after
  the grace window so a coordinator can nudge or restart the slot instead of
  silently leaving it parked.
- Use `watchdog-check` for out-of-band health checks. Frequent Codex cron
  automations create visible Codex sessions and are not suitable as quiet
  watchdogs.
- MCP can wrap this same store later.
