---
name: codenator
description: Coordinate parallel Codex focus slots with Auralis Codenator. Use when managing or participating in Codenator coordinator/focus-slot work, reading or updating the Focus Board, assigning tasks, waking slots through app-server, reporting commits, integrating worker reports, or maintaining MCP-ledger-backed parallel Codex workflows. Legacy Codextrator aliases remain supported.
---

# Auralis Codenator

Use Codenator as its own coordination layer. It is not a project-specific
task system, and it is not tied to one project. A project such as
`demo-project` is a task field inside Codenator.

## Model

- MCP ledger is durable task and message truth.
- Focus Board is the shared visible backlog: milestones, lanes, assignments,
  task progress, reports, and integration receipts.
- Browser admin dashboard is a read-only human visibility surface over that
  ledger; it is not a second coordinator and should not mutate task/session
  state.
- Codex app-server is the wake adapter.
- Desktop cron is not the backbone.
- Coordinator manages backlog and assignments.
- Worker slots read all progress, own only their lane/task, and report results.

## Coordinator Workflow

1. Call `get_status`, `get_focus_board`, and `read_inbox` for `coordinator`.
2. Check `progress.summary_pause` or `plan_wake.summary.coordinator_pause`.
   At 30+ integrations since the last pause, prepare a short Ton summary. When
   `plan_wake.decision` is `PAUSE`, stop the coordinator loop; do not wake or
   assign more work until Ton has received the summary and
   `record_summary_pause` has been called.
3. Verify any `commit_report` before integration. Do not trust worker reports
   without focused tests in the source worktree and again after integration.
4. Manage backlog with `upsert_milestone`, `upsert_lane`, and `create_task`.
5. Assign only when a slot is healthy, idle, unread 0, and has no unintegrated
   report.
6. Use `plan_wake` with `adapter="codex-app-server"` before waking slots.
7. After integrating a report, call `update_task` with status `integrated`,
   the integration commit, and verification evidence.

## Worker Slot Workflow

1. Call `record_heartbeat` for the current slot.
2. Call `get_focus_board` with `viewer_slot` set to the slot id. Read the full
   project state, not only the local task.
3. Call `read_inbox` with `mark_read=false`, then `claim_next_task` if assigned.
4. Work only in the registered worktree and module/lane boundary.
5. Keep work fixture-backed, deterministic, and non-live unless the task
   explicitly authorizes a live boundary.
6. Run focused checks, commit, then call `report_commit`.
7. If blocked, call `update_task` with a blocker and stop.

## Boundaries

- Do not use the human operator as a transport layer between sessions.
- Do not assign new work from a worker slot.
- Do not mutate another lane's files unless the task explicitly says so.
- Do not clear coordinator inbox before reports are verified and integrated.
- Do not broaden into live daemon, Discord, board mutation, production storage,
  or real worker/session execution unless explicitly approved.
