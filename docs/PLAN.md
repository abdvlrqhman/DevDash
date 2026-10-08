# DevDash — Build Plan

Status: **draft for approval** · 2026-10-08 · Mockup: [`docs/design/mockups.html`](design/mockups.html)

DevDash is a self-hosted, open-source team space on one VPS. Every dev opens it from a PC, Android or iPhone and gets Claude Code sessions (chat + real CLI), a server terminal, tasks, notes, a zero-knowledge vault, builds, files and a remote browser.

---

## 1. Decisions (defaulted — change any before Phase 1)

| # | Decision | Default | Why |
|---|----------|---------|-----|
| D1 | Network exposure | Public at `dev.spacie.net` behind Cloudflare proxy. No Tailscale. | Your call. Origin firewall only accepts Cloudflare on 443. |
| D2 | Claude accounts | Each dev logs into **their own** Claude account. DevDash never reads or stores Claude credentials. | Policy + accountability. See §5.5. |
| D3 | Claude profiles | A DevDash user owns 1..n **Claude profiles** (`CLAUDE_CONFIG_DIR`). The same Claude account can be logged into any number of profiles/users; each logs in separately (no shared token files). | Different prefs/skills per profile; avoids refresh-token races. |
| D4 | Isolation | Every DevDash user = a real Linux user. Sessions/terminals run as that user via a per-user agent. Never root. | Privacy, and `bypassPermissions` works for non-root users without `IS_SANDBOX`. |
| D5 | Default permission mode | Bypass (as in the mockup), per profile setting. | It runs as a normal user, so blast radius = that user. |
| D6 | Worktree per session | **On** by default ("Isolated worktree" toggle). | Several devs + Claudes in one checkout clobber each other, and Ask-mode "Always allow" grants land in the checkout's `.claude/settings.local.json`, shared by everyone working there. |
| D7 | Remote browser | **One shared team browser** (neko) in v1, started on demand. | RAM. Everyone sees the logged-in accounts; per-user browsers later. |
| D8 | Task refs | `fixes #12` on any branch → task moves to **Review** (linked) right away; it moves to **Done** when the commit reaches the default branch. | With D6 on, Claude commits on a worktree branch, so "Done on any commit" would close tasks from abandoned branches. Alternative: D6 off (warning chip when someone else is in the checkout) and close immediately. Collides with GitHub issue #12 if the repo uses issues. |
| D9 | Vault master password | Separate from the login password. | The login password reaches the server; the vault key must not. |
| D10 | iPhone | Unsigned IPA is a first-class target, installed by sideloading (AltStore/SideStore). PWA (Add to Home Screen) also works. | Team sideloads; confirmed 2026-10-08. |
| D11 | Mockup extras | Workspaces, Snippets, Devices/Wake, Secrets: **skipped in v1**. Push notifications: Phase 8. Remote Control: optional CLI-mode flag. | Not in the feature list; projects + private/shared sessions cover workspaces. |
| D12 | License | MIT | Simple for an open-source tool. |

---

## 2. Server facts (probed 2026-10-08)

- Ubuntu 24.04.5, 4 vCPU (Xeon Silver 4416+), **7.7 GB RAM**, 118 GB disk, Docker installed, nothing else running.
- **Found open:** root SSH login with password, no firewall. Fixed in Phase 0 (`deploy/bootstrap.sh`).

### Memory budget (the tightest constraint)

| Component | RAM |
|---|---|
| OS + Caddy | ~0.4 GB |
| DevDash server | ~0.2 GB |
| Agent per user (idle) | ~0.06 GB each |
| Claude process (CLI or Chat) | 0.3–0.5 GB each |
| neko browser (only while used) | 1.5–2.5 GB |

→ ~8–10 live Claude processes with the browser running. Rules: 4 GB swap; max **3 live Claude processes per user**, **10 global** (configurable); Chat processes with status **idle** close after 20 min and resume on the next message (sessions **waiting** for an answer or permission stay alive and count against the cap); neko stops after 30 min without viewers. **Upgrade to 16 GB** when >5 devs are active daily or the cap is hit weekly.

---

## 3. Architecture

```
 Phone / PC (PWA or Tauri shell)
        │ HTTPS + WSS
   Cloudflare (proxy, Full-strict TLS, Authenticated Origin Pulls)
        │ 443 only from Cloudflare IPs
 ┌──────┴───────────────────────────────── VPS ─────────────────────────────┐
 │ Caddy ── static web app, /api, /ws, /neko (forward_auth → server)          │
 │   │                                                                        │
 │ devdash-server (user: devdash)                                             │
 │   Hono API · WS gateway · SQLite · MCP endpoint (127.0.0.1 only)           │
 │   GitHub App · share links · build tracker · neko control                 │
 │   │  WebSocket over Unix socket (per user, mode 660 user:devdash)          │
 │ devdash-agent@alice  devdash-agent@omar  ...   (each runs AS that user)    │
 │   tmux (terminals + Claude CLI)  ·  Agent SDK (Claude Chat)  ·  file ops   │
 │                                                                            │
 │ neko (Docker, started via root helper) ── UDP 59000 / TCP 59001 direct     │
 └────────────────────────────────────────────────────────────────────────────┘
```

- **Server** owns identity, data and permissions. It never runs user code.
- **Agent** (one systemd template unit per Linux user, `devdash-agent@<user>.service`) runs everything that touches user files: PTYs, tmux, Claude processes, file reads/writes. Linux permissions do the access control. `KillMode=process` so tmux survives agent restarts; explicit tmux socket (`/run/devdash/u/<user>/tmux.sock`) so the same sessions can be attached over SSH.
- **Root helper** `devdash-helper` (one validating script, one narrow sudoers line) for the only root operations: create/disable Linux user, start/stop agent unit, start/stop neko, update Claude. The server is never root and is not in the `docker` group.

### Filesystem layout

| Path | Owner / mode | Holds |
|---|---|---|
| `/opt/devdash/app` | root, 755 | DevDash releases |
| `/opt/devdash/claude/<ver>` + `current` symlink | root, 755 | Claude Code (SDK + binary) |
| `/etc/devdash/devdash.env` | devdash, 600 | Server secrets (master key, session secret) |
| `/var/lib/devdash` | devdash, 700 | SQLite DB, GitHub App key, neko admin token, share copies, build artifacts |
| `/srv/devdash/projects/<slug>` | group `devdash-users`, setgid, 2775 | Shared checkouts (`core.sharedRepository=group`, agent `UMask=0002`) |
| `/srv/devdash/files` | group `devdash-users`, setgid | Team workspace files |
| `/home/<user>` | user, 700 | `~/.claude` (default profile), `~/.claude-profiles/*`, git/gh config |

Claude in bypass mode as `alice` can read anything `alice` can. Every server secret stays under `devdash`-owned 600/700 paths, never under `/srv`.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (Rust only for Tauri glue) | Agent SDK is TS-first; one language end to end. |
| Runtime | Node 24 LTS | node-pty 1.1 prebuilds; Agent SDK support. |
| API | Hono + `@hono/node-server` + `ws`, zod validation | Small, typed RPC client (`hc`) with no codegen. |
| DB | SQLite (WAL) + Drizzle (better-sqlite3), FTS5 for search | One VPS, small team: no DB server to run. |
| Auth | `@node-rs/argon2`, `otpauth` (TOTP) | Argon2id + mandatory 2FA. |
| Web | React 19, Vite, TanStack Router + Query, Tailwind v4, Radix/shadcn, `@tabler/icons-react` | Biggest ecosystem for xterm, editors, dnd. |
| Terminal | `@xterm/xterm` 6 (WebGL) + `node-pty` 1.1 + tmux 3.4 | tmux gives persistence + multi-device attach for free. |
| Notes editor | CodeMirror 6 (markdown) + `react-markdown` preview | Plain markdown files in the DB, no lock-in. |
| Kanban | `dnd-kit` | Touch + keyboard drag. |
| Vault crypto | WebCrypto (AES-256-GCM, ECDH P-256 / X25519 when supported) + `hash-wasm` Argon2id in a Worker | Standard primitives only. |
| Claude | `@anthropic-ai/claude-agent-sdk` + the same binary for CLI | See §5. |
| MCP | `@modelcontextprotocol/sdk` (streamable HTTP) | One server for CLI and Chat. |
| GitHub | GitHub App (manifest flow) + `octokit` | Short-lived tokens, webhooks, one-click setup. |
| Remote browser | neko v3 (`ghcr.io/m1k1o/neko/chromium`) | WebRTC, multi-user, API auth. |
| Native shell | Tauri 2.12 (Windows, Android, iOS, macOS, Linux) | One thin shell for all; Capacitor has no Windows and calls remote URLs "not for production". |
| Proxy | Caddy with Cloudflare Origin CA cert | Two-line TLS + `forward_auth`. |

### Repo layout (clean architecture, feature-sliced)

```
apps/
  server/src/
    core/           config, db, auth middleware, errors, event bus, audit
    modules/<feature>/  routes.ts (thin) · service.ts (logic) · repo.ts (db) · schema.ts (zod)
      auth, users, profiles, sessions, terminals, projects, tasks, notes,
      vault, files, shares, builds, browser, github, mcp, activity, server-status
  agent/src/        socket server, tmux, pty, claude (cli + chat), files
  web/src/
    ui/             design system (Sandstone tokens from the mockup), primitives
    features/<feature>/  routes, components, queries
  shell/            Tauri 2 thin shell (connect screen + native bits)
packages/
  shared/           zod schemas + types used by server, agent, web
  claude-plugin/    DevDash plugin for Claude Code (MCP, hooks, skill, commands)
deploy/             install.sh, devdash-helper, sudoers, systemd units, Caddyfile,
                    neko compose, tmux.conf, ufw-cloudflare.sh, backup.sh
.github/
  workflows/        ci.yml, shell-release.yml
  actions/log-stream/   composite action for live build logs (§9)
docs/               PLAN.md, SECURITY.md, design/mockups.html
```

Routes stay thin, services hold the logic, repos hold SQL. No interfaces with one implementation.

---

## 4. Client flow

1. Dev installs the shell (Windows/Android/iOS) or opens the PWA.
2. **Connect screen** (bundled in the shell): enter space domain, e.g. `dev.spacie.net`.
3. Shell calls `https://<domain>/.well-known/devdash.json` → `{ app: "devdash", name, version, minShell }`. Wrong/unreachable → inline error; too-old shell → "Update the app".
4. Valid → shell grants a runtime capability for exactly that origin (Tauri `add_capability`, `dynamic-acl`), keeps the webview on that origin, and loads `https://<domain>/`. The UI always comes from the server, so app and server never drift.
   - Links to any other origin (Claude login URL printed in a CLI tab, GitHub App setup, links in notes) open in the **system browser** (Tauri opener plugin; xterm link handler → external).
5. **Login:** email + password → TOTP (or backup code) → "Remember me" = 30-day sliding session; off = browser session, 12 h idle.
6. Home of the space (mockup §1). Shell remembers the domain; "Switch space" returns to step 2 with recents.

---

## 5. Claude sessions (core)

### 5.1 One session, two views

- **CLI** = the real `claude` TUI in a tmux session, streamed via xterm.js. 100% feature parity by construction.
- **Chat** = Agent SDK `query()` with streaming input, rendered as the mockup's chat UI.
- Both use the **same session id** and the same transcript (`<config>/projects/<cwd>/<id>.jsonl`). DevDash stores every session id in its DB (SDK sessions don't appear in `--continue` or the picker).

### 5.2 Single writer per session (required)

There is no lock in Claude Code; two live processes on one id interleave the transcript. The agent enforces it:

- In-memory map `sessionId → { mode, pid }` plus an `flock` on `~/.cache/devdash/locks/<id>`.
- **Switch mode** = (a) if a turn is running, ask "Claude is working, interrupt?"; (b) stop the current process (Chat: `interrupt()` + close input; CLI: send `/exit`, then SIGTERM after 5 s); (c) wait until the pid is gone; (d) resume in the other mode.
- Manual `claude --resume <id>` from a terminal can't be blocked; the UI shows "opened elsewhere" when the lock is held by a process the agent didn't start.

### 5.3 Identical launch config in both modes

Resume does not restore `--plugin-dir`, `--mcp-config`, `--add-dir`, `--settings`. So DevDash avoids launch-only flags:

- The **DevDash plugin is installed into every profile's `settings.json`** at profile creation (local marketplace in `/opt/devdash/claude-plugin`, `enabledPlugins`). Manual `claude` runs in a DevDash terminal get tasks/notes too.
- Per-launch values DevDash does pass (model, permission mode, effort) are stored on the session row and re-applied on every resume.
- Chat mode is a **full** Claude Code session, never a stripped SDK agent: `systemPrompt: { type: 'preset', preset: 'claude_code' }`, default `settingSources` (user + project + local), `skills: 'all'`, no `tools` restriction. Switching CLI → Chat mid-transcript therefore keeps the same system prompt.
- Env injected by the agent into **every** process it spawns: `CLAUDE_CONFIG_DIR`, `DEVDASH_URL` (127.0.0.1), `DEVDASH_TOKEN` (per-user, scoped), `DEVDASH_SESSION_ID`, `DEVDASH_TASK_ID` (when started from a task).

### 5.4 One binary, one update story

- The Agent SDK ships a native Claude Code binary pinned to its version. DevDash installs the SDK into `/opt/devdash/claude/<ver>/`; **both** Chat mode and CLI mode (and `/usr/local/bin/claude` for manual use) run that one binary via the `current` symlink. Guaranteed parity.
- **Update** (admin button + nightly timer): install new version into a new dir → smoke test (`claude --version`, a 1-turn SDK call) → flip `current` → restart agents that have no running Chat turn (tmux sessions survive) → keep the previous dir for rollback. Auto-updater disabled (`DISABLE_UPDATES=1`).
- **Spike S1 verifies the bundled binary runs the interactive TUI.** If it doesn't: fallback = apt-installed `claude-code` with `DISABLE_UPDATES`, SDK `pathToClaudeCodeExecutable` pointing at it, SDK version pinned to match.

### 5.5 Accounts, profiles and policy

- A profile = a config dir: default `~/.claude`, extra ones `~/.claude-profiles/<name>`. Own settings, skills, agents, plugins, CLAUDE.md, memory and login.
- **Login:** "Log in" on the profile opens a CLI tab running Claude's own login for that profile. DevDash only reads the result of Claude's auth status command, never the token.
- Same Claude account on 2 profiles or 2 DevDash users = log in twice (like two computers). Copying `.credentials.json` between profiles is not supported: rotating refresh tokens would log the other one out.
- **Policy (stated plainly):** Anthropic's docs say products built on the Agent SDK should use API keys and must not offer claude.ai login or route requests through Pro/Max credentials for their users. CLI mode with your own login is ordinary Claude Code use. Chat mode spawns the same binary with the same profile login, which is a gray area. DevDash never handles credentials; a profile can be pointed at a **Console API key** for strict compliance. Sharing one subscription between several people is not something Pro/Max are meant for; Team seats are the clean option.

### 5.6 Status, sharing, multi-device

- **Status** (working · waiting for you · idle · stopped · error): Chat mode reads it from the stream (`canUseTool` pending / AskUserQuestion → waiting; `result` → idle). CLI mode gets it from plugin hooks (`type: "http"` to 127.0.0.1 with the token): `UserPromptSubmit` → working, `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`) → waiting, `Stop` → idle, `SessionEnd` → stopped. (Spike S4.)
- **Private by default.** Owner taps **Share** → visible to all members. Sub-toggle **"Others can send"** (off = view only). Shared CLI viewers attach read-only (`tmux attach -r`) unless "can send" is on.
- Sharing means teammates drive Claude **as the owner** (owner's Linux user, profile and Claude account). The UI shows who sent each message (DevDash stores sender per message uuid; the transcript is not modified).
- Multi-device: all viewers get the same live stream; history loads via `getSessionMessages` (paged); clients dedupe by message uuid. CLI: each client attaches with a grouped tmux session so a phone and a PC don't fight over size.
- Cloudflare drops idle WebSockets after ~100 s → ping every 30 s, auto-reconnect with resume from the last event id.

### 5.7 Feature parity

| Feature | Chat mode | CLI mode |
|---|---|---|
| Messages, streaming, thinking blocks | ✅ rendered | ✅ |
| Tool calls (Read/Edit diffs/Bash output) | ✅ cards (mockup) | ✅ |
| Subagents / Task tool | ✅ nested by `parent_tool_use_id` | ✅ |
| Workflows, background tasks | ✅ shown as tool cards + status | ✅ |
| To-dos (TodoWrite) | ✅ checklist card + side panel | ✅ |
| AskUserQuestion | ✅ question card, answers via `updatedInput` | ✅ |
| Plan mode + plan approval | ✅ plan card (Approve / Keep planning) | ✅ |
| Permission prompts (Ask mode) | ✅ Allow / Always / Deny via `canUseTool` | ✅ |
| Slash commands, skills, plugin commands | ✅ palette from `system/init` (`slash_commands`, `skills`, `plugins`) | ✅ |
| `/compact`, `/clear`, `/context`, `/cost` | ✅ (streaming mode; `/context` verified in S5) | ✅ |
| Model, effort, permission mode switch | ✅ `setModel`, `effort`, `setPermissionMode` | ✅ |
| Interrupt | ✅ `interrupt()` | ✅ Esc |
| Images (paste/photo from phone) | ✅ base64 image blocks | ⚠️ via file path |
| @file mentions | ✅ picker | ✅ |
| Hooks, MCP, CLAUDE.md, memory, output styles | ✅ (`settingSources` default = user+project+local) | ✅ |
| `/theme`, `/terminal-setup`, agent teams | ❌ CLI only → "Open in CLI" button | ✅ |
| Remote Control (Claude app) | ❌ | ✅ optional flag, needs claude.ai login on that profile |

### 5.8 Spikes before building Phase 3 (½ day)

| # | Verify | Fallback |
|---|---|---|
| S1 | SDK-bundled binary runs the interactive TUI | apt install + pinned SDK (§5.4) |
| S2 | Pre-assign session ids (`--session-id` / SDK option) | Read id from first `system/init` and store it |
| S3 | Chat ↔ CLI round trip on one id keeps history intact | Fork on switch (`forkSession`) |
| S4 | Plugin hooks fire for CLI status (`hooks.json` must list `DEVDASH_TOKEN` in `allowedEnvVars`, or the header is empty and hooks fail silently) | Poll tmux pane + transcript mtime |
| S5 | `/context`, `/cost`, skills dispatch in SDK streaming mode | Hide from Chat palette, offer "Open in CLI" |
| S6 | Bypass as a normal user under systemd, no `IS_SANDBOX` | Run with Claude's bubblewrap sandbox enabled |

---

## 6. Terminal

- Each terminal tab = a tmux session on the user's socket, attached through node-pty in the agent. Survives disconnects, phone sleep and agent restarts.
- Mobile key bar (Esc, Tab, Ctrl, Alt, |, ~, arrows, paste) as in the mockup; xterm WebGL renderer; fit addon.
- **Admin shell:** only for admins. Fresh TOTP every time, red header, auto-close after 15 min idle, audit-logged. It opens a terminal that runs `sudo -i`, which asks for the admin's **Linux password**. A compromised DevDash server alone cannot get root.
- Provisioning (Phase 2) sets a Linux password only for admins (needed by `sudo`); member Linux accounts stay password-locked and have no sudo.

---

## 7. Projects, tasks, notes

### Projects
- Add = clone a GitHub repo (via the GitHub App) into `/srv/devdash/projects/<slug>` as the creating user. Server fetches every 5 min and on GitHub push webhooks. Commits list, branches, per-member activity (mockup §4).
- Each user commits with their own git identity (set at provisioning) and pushes with their own credentials (`gh auth login` in their terminal).

### Tasks (kanban)
- Per-project numbers (`app-mobile #18`). Columns: Backlog · Todo · In progress · Review · Done. Priority, due date, assignees, labels, comments, links to commits and sessions. Board / List / Mine views; swipe columns on phone.
- **Auto-close (D8):** after each fetch (and after local commits, via the agent watching worktree refs), scan new commits since the last scanned sha per branch. Regex (case-insensitive): `\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d+)\b`. Non-default branch → task to **Review** + linked commit. Default branch → **Done**, closed by that commit (author mapped by email). Idempotent per (task, sha). One code path for every git host; webhooks only trigger an earlier fetch.
- **"Give to Claude"**: starts a session in that project with the task as the prompt, links it, sets `DEVDASH_TASK_ID`.

### Notes
- Markdown, optional project pin, pinned-to-top flag, tags, priority, visibility team (default) or private. Pinned project notes show on the project page.
- Search everything (tasks, notes, session titles) via SQLite FTS5.

### Claude ↔ tasks/notes (DevDash plugin)
- **MCP server** at `http://127.0.0.1:<port>/mcp` (never through Caddy). `Authorization: Bearer ${DEVDASH_TOKEN}` from env (plugin `.mcp.json` expands `${VAR}`).
- Tools: `project_info`, `tasks_list`, `task_get`, `task_create`, `task_update` (status, priority, due, assignee), `task_comment`, `notes_list`, `note_get`, `note_upsert`. Project inferred from cwd when omitted. Actions are recorded as "Claude for <user>".
- Token scope: tasks, notes, project read. No vault, files, admin or builds.
- **Skill `devdash`**: conventions (move the task to In progress when starting, comment a summary when done, use `fixes #N` in the final commit).
- **Hooks**: session status (§5.6).

---

## 8. Vault (zero-knowledge)

- **Unlock:** vault master password → Argon2id (hash-wasm in a Web Worker, 64 MiB, t=3, p=4, per-user salt) → master key. Never sent to the server.
- **Keys:** each user has an ECDH keypair (X25519 when supported, P-256 otherwise). Private key stored server-side **wrapped** by the master key (not as a non-extractable IndexedDB key; Safari has a bug there).
- **Vaults:** Personal + Shared (team) + optional per-project. Each vault has a random AES-256 key, wrapped per member via ECDH + HKDF.
- **Items:** JSON (login, TOTP secret, card, note, file key) encrypted with AES-256-GCM, random 96-bit IV, AAD = vault id + item id. TOTP codes computed client-side (mockup).
- Server stores ciphertext, wrapped keys, public keys. Auto-lock timer, clipboard clear after 30 s (best effort), password generator.
- **Removing a member** rotates the shared vault key (client re-encrypts).
- **No recovery:** forgetting the master password loses the personal vault. Shared items survive through other members. Offer an "emergency kit" printout at setup.
- Honest limit: like any web vault, a compromised server could serve modified JS. Mitigations: strict CSP, no third-party scripts, SRI, the native shell.

---

## 9. Builds and files

### Files
- Roots: **Shared** (`/srv/devdash/files`), **Projects**, **Home**. All operations run in the user's agent, so Linux permissions apply. Paths resolved with `realpath` and checked against allowed roots.
- Uploads chunked at 50 MB (Cloudflare's limit is 100 MB per request), resumable.

### Share links (the only public routes besides `/.well-known` and HMAC-verified webhooks)
- Creating a link **copies** the file into `/var/lib/devdash/shares/<id>`, so the server never needs read access to user files and the link is a fixed snapshot.
- 256-bit random token (stored hashed), optional password (Argon2id), expiry (1 h / 1 d / 7 d / never), max downloads, server-side counters, revoke, audit. Rate-limited, no listing, `noindex`, `nosniff`, `Content-Disposition: attachment`.
- Large binaries through Cloudflare free plan: fine for occasional APKs/zips; heavy distribution should move to R2 later.

### Builds (GitHub Actions)
- **Connect GitHub** once: GitHub App via manifest flow (Contents read, Actions read/write, Metadata; webhooks: push, workflow_run, workflow_job). Private key stored in `/var/lib/devdash`.
- Per project, **build targets** = workflow file + ref + inputs + artifact name (Android APK, Windows, iOS unsigned, …). DevDash lists workflows that have `workflow_dispatch`.
- **One tap** → `workflow_dispatch` with `return_run_details: true` → run id.
- **Live logs:**
  - v1: live step progress (webhook `workflow_job` + jobs API `steps[]`); full log when each job finishes (REST only serves logs after completion).
  - v1 opt-in: **live text** via `.github/actions/log-stream` (tee → POST to `/api/builds/<id>/log` with a per-build token, masked with `::add-mask::`).
- On success: download artifacts → store under `/var/lib/devdash/builds` → Release card → **Share link** (same mechanism as files). Keep last N builds per target.
- Docs ship starter workflows (Gradle/Flutter APK, Windows, iOS unsigned) that Claude can adapt per project.

---

## 10. Remote browser

- neko v3 Chromium, **one shared team browser**, persistent profile volume, `shm_size: 2g`. Started by the root helper when someone opens Browser; stopped after 30 min without viewers.
- Signaling through Cloudflare (WSS). Media direct to the VPS: **UDP 59000** (UDPMUX) + **TCP 59001** (TCPMUX), `NAT1TO1=<server public IP>`. The VPS IP appears in ICE candidates, for logged-in members only. Cloudflare TURN only if someone sits on a UDP-blocked network.
- Auth: `/neko/*` behind Caddy `forward_auth` to DevDash; DevDash creates neko member sessions via its API (admin token in `/var/lib/devdash`). Single controller at a time, others watch.
- Later: CDP on 127.0.0.1:9223 so Claude (Playwright MCP) can drive the same logged-in browser. Per-user browsers when RAM allows.

---

## 11. Security

**Edge and host**
- Cloudflare: SSL **Full (strict)** with Origin CA cert, **Authenticated Origin Pulls**, Always HTTPS, min TLS 1.2, HSTS, cache bypass for `/api` `/ws`, one rate-limit rule on `/api/auth/*`.
- ufw: 443 from Cloudflare IP ranges only (script refreshes ranges), 22 (keys only), 59000/udp + 59001/tcp (neko). Everything else closed.
- SSH: no passwords, keys only (root key-only for automation). `unattended-upgrades` on. 4 GB swap. Done by `deploy/bootstrap.sh`.

**App**
- Invite-only (first admin created with `devdash admin create` on the server). Argon2id passwords, **mandatory TOTP** + 10 backup codes, rate limits + lockout.
- Opaque session tokens (hashed in DB), cookie `__Host-` + HttpOnly + Secure + SameSite=Lax. Origin check on every state-changing request **and WebSocket upgrade**.
- Strict CSP (no inline scripts, self-hosted fonts), zod validation at every boundary, audit log (logins, admin shell, shares, vault membership, builds).
- Server secrets never reachable by Linux users (§3). The MCP token is user-scoped and limited.

**Open source hygiene (before the first push)**
- `LICENSE`, `.gitignore`, `.env.example`, `SECURITY.md`. gitleaks pre-commit hook + CI job. Renovate/Dependabot, actions pinned by SHA, lockfile committed. No hostnames, IPs or keys in the repo; the domain is config.

**Backups**
- Nightly: `VACUUM INTO` snapshot of SQLite + restic of `/var/lib/devdash`, `/etc/devdash` (master key: without it nobody can pass 2FA after a restore), `/srv/devdash`, `/home` to off-site storage (R2 or B2). Restore tested once per phase.

---

## 12. Phases

Times are build time for Claude, excluding your review.

| Phase | Ships | Est. | Needs from you |
|---|---|---|---|
| **0. Harden server** ✅ | Rotate root password, admin user + SSH key, disable root/password SSH, ufw, swap, Node 24, tmux, Caddy, bubblewrap | ~1 h | Your SSH public key; Cloudflare Origin cert + AOP toggle |
| **1. Foundation** ✅ | Repo hygiene + CI + gitleaks, monorepo, server/web skeleton, design system from mockup, auth (invite, TOTP, remember me), `/.well-known/devdash.json`, deploy script, first deploy | ~1 day | Admin email |
| **2. Users + Terminal** ✅ | Root helper, Linux user provisioning, agent unit, terminal tabs, mobile keys, admin shell | ~1 day | — |
| **3. Claude sessions** ✅ | Spikes S1–S6, profiles + login, CLI mode, Chat mode, mode switching, sharing, status, palette, model/effort/mode sheet, images, caps | ~2–3 days | Each dev logs into Claude once |
| **4. Projects, tasks, notes** ✅ | Projects + fetch (each member's own `gh` login instead of a GitHub App), kanban, auto-close, notes, search, DevDash plugin (MCP + skill + hooks), "Give to Claude", activity feed | ~2 days | Click "Connect GitHub" |
| **5. Files + builds** ✅ | File browser, chunked upload, share links, build targets, dispatch, live progress, log-stream action, artifacts → share links | ~2 days | A project with a build workflow |
| **6. Vault** ✅ | Keys, personal + shared vaults, items, TOTP, generator, auto-lock, key rotation | ~1.5 days | — |
| **7. Remote browser** ✅ | neko on demand, forward_auth, ports, idle stop | ~½ day | — |
| **8. Shell + polish** ✅ | Tauri shell (connect screen, dynamic capability), release workflow (Windows, Android APK, iOS unsigned), web push, server status page, backups | ~1–2 days | — |

Each phase ends deployed on `dev.spacie.net`, with a short demo checklist and its tests passing in CI.

---

### What changed while building (2026-10-08)
- **GitHub:** no GitHub App. Each member connects their own GitHub (`gh`, Account → GitHub); cloning, fetching, pushing and builds run as them.
- **Claude tools:** the DevDash MCP server is a stdio script in the plugin that talks to the member's own agent socket (no tokens); the agent relays to the server over its event connection.
- **Services center** (added): long-running servers and containers on ports 20000-20999, kept up 24/7, `devdash service` CLI; Claude is told to use it.
- **Vault KDF:** PBKDF2-SHA256 (600k) in WebCrypto instead of Argon2 (no extra library); keys P-256 ECDH. Optionally stays unlocked on a device, sealed with a non-extractable device key.
- **Remote browser:** neko multiuser mode (its bundled client needs it): members with full control, invite links for watch-only guests. uBlock Origin Lite ships with the image (Chromium no longer runs MV2 extensions).
- **Backups:** nightly local snapshots (database, /etc/devdash, data; 14 days), optional off-site with restic via /etc/devdash/backup.env.
- **Service addresses:** https://<space>:8443/service/<name>/ (the team chose paths over wildcard DNS). The separate port is a separate origin, so service pages can't act on DevDash; members get in with their DevDash session, public services for anyone with the link.
- **Backups:** kept on the server only (the team's choice); restic off-site stays available via /etc/devdash/backup.env.

## 13. Out of scope for v1

Workspaces, Snippets, Devices/Wake-on-LAN, project Secrets (use the vault), per-user browsers, Claude driving the shared browser (CDP), native push on iOS (needs paid Apple account), i18n/RTL.
