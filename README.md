# DevDash

A self-hosted team space on one Linux server: Claude Code sessions (chat and real CLI), a server terminal, tasks, notes, a zero-knowledge vault, builds, files and a remote browser. Use it from a PC, Android or iPhone.

**Status:** early. Phase 1 of 9 (accounts, 2FA, invites). See [`docs/PLAN.md`](docs/PLAN.md) for the full plan and [`docs/design/mockups.html`](docs/design/mockups.html) for the design.

## Self-host

Needs a fresh Ubuntu 24.04 server and a domain proxied by Cloudflare.

1. Harden the host (SSH keys only, firewall that admits only Cloudflare on 443, Node 24, Caddy):
   `scp deploy/bootstrap.sh deploy/ufw-cloudflare.sh root@SERVER:/root/ && ssh root@SERVER /root/bootstrap.sh <admin-user> "$(cat ~/.ssh/id_ed25519.pub)"`
2. Deploy from your clone: `deploy/deploy.sh root@SERVER --domain dev.example.com --name "My team"`
3. Create the first admin on the server: `devdash invite --email you@example.com --username <admin-user> --role admin`, then open the printed link.

TLS: until `/etc/caddy/certs/origin.crt` (a Cloudflare Origin CA certificate) exists, Caddy serves an internal certificate. Re-run step 2 after adding it.

## Develop

```sh
cp .env.example .env            # then set DEVDASH_MASTER_KEY
npm install
git config core.hooksPath .githooks   # secret scanning before every commit (needs gitleaks)
npm run dev:server & npm run dev:web  # http://localhost:5173
npm run invite -- --email you@example.com --username you --role admin
npm test && npm run typecheck
```

Server: Node 24 + Hono + built-in SQLite, TypeScript run directly by Node. Web: React + Vite + Tailwind.

## License

MIT. Security reports: see [SECURITY.md](SECURITY.md).
