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
- Commit reports.
- Status view with unread counts.
- Codex hook entrypoint for post-tool commit detection.
- No cloud dependency.
- No runtime dependency beyond Node.js.

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
  reports/
  tasks/
  hooks/
```

## Design Notes

- Keep session slots generic: `session-01`, `session-02`, etc.
- Use registry metadata for project/focus/worktree/branch.
- Keep identity separate from focus.
- Use hooks for automatic reports, not for hidden work.
- MCP can wrap this same store later.
