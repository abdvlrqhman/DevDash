# Removing Team

Team (AI team members for projects, [TEAM-ROLES.md](TEAM-ROLES.md)) is built so it can be taken out in about an hour.
DevDash never depends on it. Keep this list current when Team changes; `apps/server/src/modules/team/boundary.test.ts`
fails if code outside it starts using Team.

## Try it without first

Set `DEVDASH_TEAM=0` in `/etc/devdash/devdash.env` and restart DevDash: no listeners, no shifts, no tools, and the
Team tab says it's off. Nothing is deleted.

## Remove it

1. **Export** what you want to keep: the `team_*` tables (roles, notebooks, decisions, shift reports, journal).
2. **Delete the folders**
   - `apps/server/src/modules/team/`
   - `apps/web/src/features/team/`
   - `packages/claude-plugin/mcp/team.mjs`
3. **Delete the plug-in lines** (each is marked `Team` or `Team (optional)`):
   - `apps/server/src/app.ts`: the `teamPlugin` import, `const team = teamPlugin(…)`, `.route('/api/team', …)`
   - `apps/web/src/main.tsx`: the `teamRole` and `approvals` routes and their entries in the route tree
   - `apps/web/src/features/projects/ProjectPage.tsx`: the `TeamTab` import, the Team tab trigger and its content
   - `apps/web/src/components/app/shell.tsx`: the `ApprovalsBadge` import, the Approvals nav item and its badge line
   - `apps/web/src/features/more/MorePage.tsx`: the Approvals link
   - `packages/claude-plugin/mcp/devdash.mjs`: the `team.mjs` import; `tools()` becomes `TOOLS`
4. **Drop the tables** with a new migration: `team_projects`, `team_briefs`, `team_decisions`, `team_roles`,
   `team_notebook`, `team_shifts`, `team_journal`, `team_proposals`, `team_goals`.
5. **Optional:** archive the role sessions (`claude_sessions` where `listed = 0` and the title ends in ": shift", plus
   each role's chat).

## What stays, and why

These are general session features Team uses; other features can use them too:

- `claude_sessions.instructions`, `tool_policy`, `listed` (migration 015) and `SessionExtras` in the Claude service
- `claude.onTurnEnd` (with each turn's cost), `claude.transcript`, `claude.complete`, `claude.configure`
- the agent's `claude.complete` op and the `instructions` / `toolPolicy` launch options
