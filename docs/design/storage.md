# Members' own cloud storage (Google Drive)

**Status:** built. Each member connects their own Google Drive once; their Claude sessions (every profile, Chat and
CLI) and their terminals reach it as the rclone remote `drive:`, so big outputs — videos, renders, datasets — leave
the shared server's disk.

## Shape

- **One Google OAuth app per space**, registered once by an admin on the Storage page (client ID + secret, the secret
  sealed with the master key). Each member connects their own Drive through it.
- **Scope `drive.file`** (plus `openid email` to know the account). DevDash only sees files it creates — a `DevDash`
  folder in the member's Drive — never the rest of it. All three scopes are non-sensitive, so the app can be published
  "In production" with no Google review. Left in "Testing", Google blocks anyone not listed as a test user ("has not
  completed the Google verification process", 403 access_denied) and every connection dies after 7 days. A logo on the
  consent screen would need brand verification, so the app has none.
- **rclone does the transfers**, in the member's own Linux account: chunked, resumable, retried uploads of multi-GB
  files. `rclone move` deletes the local copy only after a successful upload. Pinned and hash-checked in
  `deploy/install.sh`.
- **The Google refresh token never leaves the server.** The member's `~/.config/rclone/rclone.conf` gets a `[drive]`
  remote whose `token_url` is DevDash's loopback endpoint and whose "refresh token" is an opaque per-member handle
  (`ddh_…`). rclone refreshes against that endpoint; the server trades the handle for a short-lived Google access token.
  Disconnecting (or reconnecting) kills the handle at once, wherever a copy of the file went. The Google client secret
  stays on the server too.

```
Claude session (as bob) ── rclone move out.mp4 drive:videos/ ──► googleapis.com (Bearer access token)
        │ needs a token
        └─► POST http://127.0.0.1:8787/internal/storage/token  refresh_token=ddh_…  (loopback only)
               └─► DevDash server: handle → bob's sealed Google refresh token → oauth2.googleapis.com/token
```

## Pieces

| Where | What |
| --- | --- |
| `apps/server/migrations/039_member_storage.sql` | `storage_apps` (the space's Google app), `member_storage` (one row per member: account, folder, sealed refresh token, handle hash + sealed handle, `broken`) |
| `apps/server/src/modules/storage/google.ts` | OAuth (PKCE S256, `access_type=offline`, `prompt=consent`), the folder, the quota |
| `apps/server/src/modules/storage/service.ts` | connect / callback / disconnect, the token broker (cached, de-duplicated refreshes), `forLaunch` |
| `apps/server/src/modules/storage/routes.ts` | `/api/storage/*` and `/internal/storage/token` |
| `apps/agent/src/storage.ts` | writes/removes the `[drive]` section (other remotes untouched), and the note Claude gets |
| `apps/web/src/features/storage/StoragePage.tsx` | the Storage page, the admin setup, and `/storage/callback` |

## Flows

- **Connect:** the Storage page asks for a consent URL (single-use `state` bound to the member, PKCE verifier kept
  server-side, ten minutes). Google returns the browser to `/storage/callback`, a page outside the sign-in guard that
  posts the code to the API. The state says whose connection it is, so it also completes in the system browser (the
  native app opens Google there: Google refuses sign-in inside web views); a browser signed in to DevDash as *another*
  member is refused, so a member can't slip their own link to a teammate. The server checks Drive access was actually
  granted (Google lets people untick scopes), finds or creates the `DevDash` folder, stores the sealed tokens, and asks
  the member's agent to write the remote.
- **Every session start:** the launch carries the owner's storage (or null); the agent makes sure the remote is right
  (a new profile, a deleted config) and adds a note to Claude's system prompt: where big files go and the commands.
- **Broken:** Google answering `invalid_grant` (the member revoked DevDash, or it expired) marks the row; sessions stop
  getting the remote and the Storage page asks to connect again. A different Google app (new client ID) marks everyone.
- **Disconnect:** revokes at Google, deletes the row (the handle stops working), and removes DevDash's `[drive]`
  section — only if it points at DevDash's token endpoint, so a member's own `drive` remote is never touched.

## Limits worth knowing

- Personal Google accounts have **15 GB** shared with Gmail and Photos; videos need a Google One plan. The Storage page
  shows usage; Claude is told to check `rclone about drive:` before big uploads.
- Drive accepts files up to 5 TB and **750 GB of uploads per account per day**.
- Under `drive.file`, files a member adds to the folder by hand in Google Drive are invisible to DevDash. Letting
  Claude read those would need a Google Picker (later) or a restricted scope (Google's paid security assessment).
- Service accounts can't own files in a personal Drive, so they're no alternative without Google Workspace.
