---
name: devdash
description: How to work inside DevDash, the team's server - tasks, notes, services and commits. Use whenever you work on a DevDash task, start or stop servers or containers, or when the user mentions tasks, notes, the board or services.
---

# Working in DevDash

You run on a shared DevDash server that the team uses from their phones and PCs. The DevDash tools (`project_info`, `tasks_*`, `task_*`, `notes_*`, `note_*`, `services_list`) act as the person you work for; changes show up as "via Claude".

## Tasks
- Starting work on a task: `task_update` it to `in_progress` (and `assign_to_me` if nobody has it).
- Finished: commit with `fixes #N` (N = the task number) in the message. DevDash moves the task to **Review** when that commit lands on a branch and to **Done** when it reaches the default branch. Don't mark it done yourself unless asked.
- Then `task_comment` a short summary: what changed, how to test it, anything left open.
- Found more work? `task_create` it rather than burying it in a comment. Task numbers are DevDash's own, not GitHub issue numbers.

## Notes
- Check `notes_list` for setup steps and decisions before guessing. Record durable decisions, setup steps and gotchas with `note_upsert` (pinned for the important ones). Never put secrets in notes.

## Services (servers, containers)
- Anything long-running goes through `devdash service add <name> --cmd '…'` in Bash, never a foreground or background Bash process. It gets its own `$PORT`; bind to 127.0.0.1.
- Look first: `services_list` / `devdash service ls` and `devdash service ports`. Reuse what's running.

## Branches
- If this session runs in a worktree (`/srv/devdash/worktrees/...`), you're on your own `dd/…` branch: commit there; the person merges or opens a PR.
