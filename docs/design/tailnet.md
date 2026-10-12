# Per-user tailnets — design plan (draft for review)

**Status:** proposal, not built. For Youssef's reverse-engineering workflow: let a
specific Claude session reach his own devices (jailbroken iPhone over SSH + frida,
IDA Pro MCP on his PC or a VPS) from the DevDash server, from anywhere, without
putting the shared server on anyone's private network.

This supersedes decision **D1** ("No Tailscale") only for *outbound* reach from the
server to a user's own devices. The server's public exposure is unchanged: still
Cloudflare-only on 443, no inbound Tailscale.

## Goals

- A user flips "reach my tailnet" on one Claude session; inside it `ssh`, `curl`,
  `frida -H <ip:port>` and the IDA Pro MCP (by its tailnet URL) just work.
- A **Network** page in the app: paste an auth key to connect, see the node's
  status, and a live list of the user's devices (name, tailnet IP, OS, online dot).
- Claude can ask "is my iPhone / IDA box up?" before it tries (`net_check`).
- **Isolation:** each user has their *own* tailnet (their own Tailscale account).
  Only that user's own Claude sessions can reach it. Teammates set up their own,
  separate tailnet; nothing is shared unless they add each other inside Tailscale.

## Why this shape

DevDash already runs a `devdash-agent@<user>` as each member's **own Linux user**
(`deploy/systemd/devdash-agent@.service`, `User=%i`). That is the anchor: each user
gets their own Tailscale node, running **in userspace inside their own agent**.

- **Userspace mode needs no root** (`tailscaled --tun=userspace-networking`). It
  creates no TUN device and does not touch host networking; traffic leaves through
  a per-user **SOCKS5 proxy** on a local port. This is Tailscale's container model.
- Each node logs into **the user's own Tailscale account**, so it is on *their*
  tailnet with their iPhone/PC/VPS already present. Separate accounts ⇒ separate
  tailnets ⇒ isolation by construction.
- The shared server itself never joins any tailnet. Teammates' sessions have no
  route to your devices.

Alternatives rejected: raw WireGuard (manual keys + NAT), SSH reverse tunnels
(fragile across network changes), public port-forward of frida/IDA (the thing we
are avoiding). Tailscale is WireGuard with NAT traversal + key management solved,
and DERP relays make CGNAT cellular reachable without port-forwarding.

## The one root step (one-time, an admin runs it)

Install the binaries on the host and **disable the system-wide daemon** (we only
want per-user userspace nodes, not a host node):

```sh
curl -fsSL https://tailscale.com/install.sh | sh
systemctl disable --now tailscaled        # no host-level node
```

Goes into `deploy/bootstrap.sh` so new servers get it. After this, everything
below is per-user and rootless and deploys the normal DevDash way.

## Architecture

### Per-user node (in the agent, `apps/agent`)
A supervisor the agent starts on demand:

```
tailscaled --tun=userspace-networking \
  --statedir=$HOME/.local/share/devdash-tailscale \
  --socket=$HOME/.local/share/devdash-tailscale/tailscaled.sock \
  --socks5-server=127.0.0.1:<port> \
  --outbound-http-proxy-listen=127.0.0.1:<port2>
tailscale --socket=... up --auth-key=<key> --hostname=devdash-<user> --accept-routes
```

- Started when the user first connects; supervised (restart on crash) like other
  long-lived agent work. State persists so a re-auth key is rarely needed.
- `tailscale --socket=... status --json` → device list + online status (no admin
  API token needed for this).

### Reaching devices from a session
When a session has "reach my tailnet" on, the agent injects the user's proxy into
that Claude process's environment: `ALL_PROXY=socks5://127.0.0.1:<port>`,
`HTTPS_PROXY=http://127.0.0.1:<port2>`. Then:
- **SSH / frida / any TCP:** through the SOCKS proxy (ssh `ProxyCommand` or
  `ALL_PROXY`; frida honours the proxy env / proxychains).
- **IDA Pro MCP:** confirmed HTTP/SSE (`http://127.0.0.1:13337/mcp` + `/sse`).
  One change on the IDA box: bind it to that machine's **tailnet IP** instead of
  `127.0.0.1` (tailnet peers only, nothing public). DevDash adds
  `http://<tailnet-ip>:13337/mcp` as an HTTP MCP server on the session; the proxy
  routes it over the user's tailnet.
Sessions without the toggle get no proxy and no route.

### App surface (`apps/server` + `apps/web`)
- **Network page** (account/settings): paste auth key (sealed in the vault),
  Connect / Disconnect, node status, and the device list with live online dots.
- **Per-session toggle**: "Reach my tailnet" on the Claude session view + an
  optional IDA MCP URL field.
- **Claude tools** (DevDash MCP, only in the owner's own sessions):
  `net_devices` (list devices + online/offline), `net_check <device>` (one device).

### iPhone (device side) — stability is the open risk
Three options, easy→stable, chosen path is #1 first:
1. **App Store app + Connect On Demand (always-on).** Easiest, no jailbreak for
   Tailscale. On cellular it reaches the server via **DERP** (CGNAT-safe), no
   port-forwarding. Caveat: iOS suspends the network extension and it can stick on
   a stale interface after a Wi-Fi↔cellular change or long sleep, needing a
   toggle/relaunch (tailscale#21163). Not fixable by us (Apple NE limit).
   Mitigation = `net_check` gives instant visibility, so recovery is "glance + toggle."
2. **Native `tailscaled` launchd daemon on the jailbroken device** — the truly
   stable option (not subject to NE suspension), but **unproven**: the real gate is
   whether a working `tailscaled` binary exists for the jailbroken-iOS environment —
   spike that first. Reboot/launchd-crash risk (Dopamine#985) is acceptable here:
   Youssef re-applies the jailbreak by hand after any reboot (frida/SSH need it too),
   so the daemon only has to survive **network flaps, not reboots** — a much easier
   bar, and exactly where a native daemon beats the App Store app. Still: don't
   build first.
3. **`sshd` + `frida-server` under their own launchd daemon** regardless of 1/2 —
   device-side, solid, independent of the Tailscale app. Runbook in `docs/`.

**Plan: ship #1, keep #3; escalate to #2 only if #1 is too flaky in real use.**

## The hard part to settle in a spike (½ day)

**Proxy isolation on a shared box.** The SOCKS/HTTP proxy listens on `127.0.0.1`,
so in principle another local user could connect to that port. The proxy is only
*injected* into the owner's sessions, but injection is not enforcement. Options to
evaluate, strongest first:
1. **Per-user network namespace** for the node + proxy (clean isolation; needs a
   one-time root helper to set up the netns, fits the existing `devdash-helper`).
2. **iptables owner-match** allowing only the owner's uid to the proxy port (root
   once, via the helper).
3. Accept localhost exposure within the trusted team (weakest; document it).

Pick one before building the injection path. Everything else is standard.

## Phases

1. **Spike** — userspace tailscaled per user + proxy isolation decision (above).
2. **Node + Network page** — auth-key connect (vault-sealed), status, device list.
3. **Session reach** — per-session toggle, proxy injection, IDA MCP URL.
4. **Claude tools** — `net_devices`, `net_check`.
5. **Device runbook** — iPhone On-Demand + launchd for sshd/frida; PC/VPS notes.

## Settled with Youssef

- **Auth key:** paste a **reusable, no-expiry** key (sealed in the vault) → paste
  once, never touch again. One key covers headless nodes; the PC uses app login.
- **IDA Pro MCP:** HTTP/SSE confirmed (port 13337). Bind it to the tailnet IP.
- **Roles:** build for interactive sessions first, roles off; per-role opt-in later.
- **iPhone:** option #1 (app + always-on) first; #2 (native daemon) only if needed.
