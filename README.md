# auralis-codenator

Parallel session orchestration for Codex Desktop.

`auralis-codenator` is a small local utility for coordinating multiple
focused Codex Desktop sessions across projects, worktrees, inboxes, hooks, and
commit reports, and a shared Focus Board.

The project was originally named Auralis Codextrator. Existing `codextrator`
CLI commands, environment variables, and `.auralis-codextrator` store paths
remain supported as legacy aliases so existing ledgers do not need migration.

It is intentionally not an agent identity system. A session slot such as
`session-01` is only a technical focus slot. Identity, project, focus, worktree,
and branch live in the registry metadata.

## MVP Features

- Local registry of focus sessions.
- Per-session inboxes.
- Lightweight direct messages.
- Durable task records.
- Shared Focus Board with milestones, lanes, assignments, reports, integration
  receipts, and coordinator summary-pause state.
- Read-only browser admin dashboard for slots, tasks, current work, milestones,
  and wake-plan state.
- Slot registry view with current task and heartbeat state.
- Structured message ledger.
- Heartbeat health records and recovery summary.
- Commit reports.
- Status view with unread counts.
- Codex hook entrypoint for post-tool commit detection.
- No cloud dependency.
- No runtime dependency beyond Node.js.

## Codex Plugin Bundle

This repository now carries a local Codex plugin bundle:

- `.codex-plugin/plugin.json`: plugin metadata.
- `.mcp.json`: local MCP server wiring for the durable Codenator ledger.
- `skills/codenator/SKILL.md`: coordinator and worker operating guidance.

The bundle is local-path neutral. After connecting it as a local Codex plugin
and restarting Codex, the `auralis-codenator` MCP server exposes the same
ledger, task, wake, report, and Focus Board tools from inside Codex. Set
`AURALIS_CODENATOR_ROOT` in the host environment when you want all sessions to
share a specific durable ledger directory. The legacy
`AURALIS_CODEXTRATOR_ROOT` name is still accepted.

## MCP Mode

Codenator now has an MCP server that uses the same local store without relying
on Codex Desktop automations or `target_thread_id` resume.

Run it with:

```powershell
node .\src\server.js `
  --root C:\codenator-ledger `
  --agent coordinator
```

Suggested Codex MCP config:

```toml
[mcp_servers.auralis-codenator]
command = "node"
args = ["./src/server.js"]
```

MCP tools:

- `get_status`: read slots, unread cursor counts, heartbeat, and task state.
- `get_focus_board`: read the shared backlog, milestone, lane, assignment,
  report, and integration snapshot.
- `upsert_milestone`: coordinator-only milestone create/update.
- `upsert_lane`: coordinator-only module lane create/update.
- `register_slot`: create or refresh a stable focus slot. It can also store an
  explicit `app_server_thread_id` for a Codex app-server wake adapter.
- `send_message`: append a durable ledger message.
- `read_inbox`: read unread messages through a cursor without deleting files.
- `create_task`: queue a task and deliver a `task.assign` message. Tasks can
  carry `milestone_id`, `lane_id`, `dependency_ids`, `acceptance_criteria`,
  `required_receipts`, and a visible progress summary for board use.
- `claim_next_task`: claim the next queued task and mark it active.
- `update_task`: update status, commit, tests, or blockers.
- `report_commit`: report a focus-slot commit to the coordinator.
- `record_heartbeat`: record live-run health with `run_id`, not Desktop thread id.
- `plan_wake`: build a safe MCP-ledger wake plan without mutating inboxes,
  tasks, or Codex Desktop threads.
- `record_summary_pause`: record that the coordinator stopped and summarized
  progress after the periodic integration threshold.
- `record_wake_attempt`: persist notify-only or adapter wake proof records.

Design boundary: Codex automations should not be the primary transport for
focus-slot work. If used later, they should only act as an external watchdog.
Actual coordination should happen through the MCP inbox/task/report tools.

### Browser Admin Dashboard

`codenator-admin` starts a local read-only dashboard over the same durable
MCP ledger. It does not assign tasks, clear inboxes, wake sessions, mutate
Codex Desktop state, or integrate commits. Use it when humans need visibility
without keeping worker chats open in the Codex Desktop sidebar.

```powershell
node .\bin\codenator-admin.js `
  --root C:\codenator-ledger `
  --port 8787
```

Open the printed local URL in a browser. The dashboard shows:

- active slots, project/focus, heartbeat, inbox, current task, and app-server
  thread readiness;
- task pool filtered by open, reported, integrated, or all tasks;
- current work per slot, including idle/safe-to-assign wake-plan state;
- milestones and task-count progress;
- the latest non-mutating `plan_wake` decision.

### Wake Watcher Proof

`plan_wake` is the first external-watch primitive. It reads only MCP registry,
cursor inbox, task, and heartbeat state, then returns one of:

- `DONT_NOTIFY`: nothing actionable is waiting.
- `NOTIFY`: coordinator attention or recovery is needed.
- `WAKE`: one or more healthy slots have unread work and should be nudged by an
  external adapter.
- `PAUSE`: the coordinator has reached the periodic summary threshold and must
  stop, summarize for Ton, then call `record_summary_pause` before more wake or
  assignment.

The tool is deliberately non-mutating. It does not claim tasks, clear inboxes,
start Desktop automations, or create Codex app-server turns. With
`adapter: "codex-app-server"` it returns a ready `turn/start` request only for a
slot that has an explicit `app_server_thread_id`; otherwise it stays in dry-run
mode and marks the missing requirement instead of guessing a thread id.

After an external helper performs a notify-only or app-server wake attempt, it
can call `record_wake_attempt` to write an audit record under `wake/`.

The coordinator summary-pause guard counts integrated or done tasks. After 35
integrations since the last pause marker, `plan_wake` returns `PAUSE` and
converts slot actions to `summary_pause_hold`. The recommended operating window
is 30-40 integrations: use the Focus Board warning at 30 to prepare the brief
summary, stop at 35, give Ton the summary, then call `record_summary_pause` to
reset the counter.

For local schedulers or a standalone daemon, use the CLI wrapper:

```powershell
node .\bin\codenator-mcp-watch.js `
  --root C:\codenator-ledger `
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
node .\bin\codenator-app-server-proof.js `
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
For stored Desktop threads, the adapter calls `thread/resume` before
`turn/start`; a fresh app-server process does not know old threads until they
are resumed.

Dry-run:

```powershell
node .\bin\codenator-wake-adapter.js `
  --root C:\codenator-ledger `
  --json `
  --dry-run
```

Send mode:

```powershell
node .\bin\codenator-wake-adapter.js `
  --root C:\codenator-ledger `
  --slot session-01 `
  --json `
  --send `
  --prompt "Harmless wake proof. Do not use tools. Reply briefly."
```

If a send is attempted without a registered app-server thread id, the adapter
records a blocked wake attempt under `wake/` with
`reason=missing_app_server_thread_id` and exits non-zero. Dry-run mode does not
write wake attempts.

For a harmless loopback proof through a temporary read-only thread:

```powershell
node .\bin\codenator-wake-adapter.js `
  --test-thread `
  --json `
  --effort low
```

### App-Thread Discovery

To create a new persistent headless app-server thread for a slot:

```powershell
node .\bin\codenator-app-thread-start.js `
  --slot session-01 `
  --cwd C:\workspace\worktrees\session-01 `
  --json
```

The command prints the new thread id and verifies the thread can answer a
readiness turn. It does not mutate the Codenator registry by itself; register
the returned id with `register_slot` or run discovery/apply afterward. This
keeps thread creation separate from durable slot metadata.

`codenator-app-thread-discover` scans local Codex Desktop session JSONL files
and proposes app-server thread ids for slots whose startup prompts explicitly
name `slot session-XX` or `slot coordinator`. Default mode is read-only:

```powershell
node .\bin\codenator-app-thread-discover.js `
  --root C:\codenator-ledger `
  --slots session-01,session-02,session-03,session-04 `
  --json
```

To store the discovered metadata for non-coordinator slots:

```powershell
node .\bin\codenator-app-thread-discover.js `
  --root C:\codenator-ledger `
  --slots session-01,session-02,session-03,session-04 `
  --apply `
  --json
```

This only writes `app_server_thread_id` metadata to the Codenator registry.
It does not send app-server turns, claim tasks, clear inboxes, or touch Desktop
automations.

### Daemon Watch

`codenator-daemon-watch` packages the wake path for an external local watcher.
Default mode is one dry-run cycle:

```powershell
node .\bin\codenator-daemon-watch.js `
  --root C:\codenator-ledger `
  --json `
  --once
```

Loop mode is opt-in:

```powershell
node .\bin\codenator-daemon-watch.js `
  --root C:\codenator-ledger `
  --json `
  --loop `
  --interval-ms 300000
```

Send mode is also opt-in and uses the proven app-server sequence:
`thread/resume` followed by `turn/start`. A real send must include either an
explicit `--prompt` for proof/manual use or `--prompt-mode work` for guarded
task wakeups; otherwise the daemon records
`reason=explicit_prompt_mode_required` and does not call app-server.

```powershell
node .\bin\codenator-daemon-watch.js `
  --root C:\codenator-ledger `
  --slots session-04 `
  --send `
  --prompt "Harmless wake proof. Do not use tools. Reply briefly." `
  --json
```

For real task wakeups, use the guarded work prompt:

```powershell
node .\bin\codenator-daemon-watch.js `
  --root C:\codenator-ledger `
  --slots session-04 `
  --send `
  --prompt-mode work `
  --json
```

The work prompt tells the slot to record a fresh heartbeat, read its inbox,
claim only a delivered `task.assign`, stay inside its registered worktree,
avoid live/v1 roots and other slots, run focused tests, commit, and report the
commit back to the coordinator.

The daemon watch does not integrate commits, assign tasks, clear inboxes, or
mutate Desktop automations. It only reads MCP wake state, sends ready wake
actions when explicitly enabled, and records wake attempts under `wake/`.

## Quick Start

Initialize a shared store:

```powershell
node .\bin\codenator.js init --root C:\workspace
```

Register a session slot:

```powershell
node .\bin\codenator.js register session-01 `
  --project demo-project `
  --identity developer `
  --focus "Feature A" `
  --worktree C:\workspace\demo-project-feature-a `
  --branch feature/demo-a
```

Send a message:

```powershell
node .\bin\codenator.js send coordinator `
  --from session-01 `
  --subject "Feature A ready" `
  --message "Committed the first draft for review."
```

Read inbox:

```powershell
node .\bin\codenator.js inbox coordinator
```

Assign a structured task:

```powershell
node .\bin\codenator.js task-create session-01 `
  --task-id session-01-round-1 `
  --title "Round 1: focused slice" `
  --message "Work only in the assigned files, test, commit, and report."
```

List tasks and slots:

```powershell
node .\bin\codenator.js task-list
node .\bin\codenator.js slots
```

Import already-queued inbox messages into task records without sending
duplicates:

```powershell
node .\bin\codenator.js task-import-inbox session-01
```

Record heartbeat health:

```powershell
node .\bin\codenator.js heartbeat session-01 `
  --status ok `
  --automation-id auralis-codenator-session-01
```

Show recovery recommendations:

```powershell
node .\bin\codenator.js recovery
```

Run a quiet watchdog check that does not create Codex sessions and does not
mutate inboxes, tasks, or focus-slot state:

```powershell
node .\bin\codenator.js watchdog-check --json
```

`watchdog-check` reads coordinator inbox, recovery, and heartbeat health, then
returns `NOTIFY` or `DONT_NOTIFY`. It records only watchdog state under
`watchdog/` so repeated alerts can be snoozed without clearing real work.
Use this from an OS scheduler or a long-running local helper instead of a
frequent Codex cron automation when sidebar noise matters.

Example quiet local check:

```powershell
$env:AURALIS_CODENATOR_ROOT = "C:\codenator-ledger"
node .\bin\codenator.js watchdog-check `
  --json `
  --snooze-minutes 20
```

This command is intentionally not an actor. It should never perform
integration, task assignment, inbox clearing, or Desktop thread creation.

Show status:

```powershell
node .\bin\codenator.js status
```

Submit a commit report from the current worktree:

```powershell
codenator report-commit
```

The `codenator` binary name is preferred for new usage. The older
`codextrator` binary remains available for compatibility.

## Codex Hooks

Codex hooks can call deterministic commands on lifecycle events. The MVP
provides a `hook-post-tool-use` entrypoint that inspects hook input and submits a
commit report when it sees a git commit command.

Print a hook template:

```powershell
node .\bin\codenator.js hook-template
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

The store directory keeps the original `.auralis-codextrator` name for
compatibility. Treat it as Codenator-owned data.

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
