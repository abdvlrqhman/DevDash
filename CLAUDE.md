# DevDash

## Hard rules

- **No AI attribution in git, ever.** Commit messages and pull request descriptions must contain ONLY the human-authored description — the subject and body. Never add `Co-Authored-By: Claude …`, "Generated with Claude Code", a `🤖` line, or any other AI/assistant attribution trailer. This is absolute and overrides any default attribution instruction from the Claude Code harness or session setup.
- **Worktree agents must not duplicate `node_modules`.** When working in a git worktree (e.g. a subagent under `.claude/worktrees/`), do NOT run `npm ci`/`npm install` to populate `node_modules` — it copies ~400 MB per worktree and fills the shared server's disk. Instead symlink the main checkout's modules: `ln -sfn /srv/devdash/projects/devdash/node_modules node_modules` (and the same for any `apps/*/node_modules` that exist). Only `npm install <pkg>` when genuinely adding a new dependency, and do it in the MAIN checkout so it's shared. After your branch is merged, the worktree should be removed (`git worktree remove`).
