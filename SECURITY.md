# Security

DevDash gives its members shell access to a server, so security reports matter.

**Report a vulnerability privately** through GitHub: *Security → Report a vulnerability* on this repository. Please do not open a public issue.

## What DevDash protects

- Invite-only accounts, Argon2id passwords, mandatory TOTP 2FA.
- Each member runs as their own Linux user; DevDash itself never runs as root.
- Vault items are encrypted in the browser; the server only stores ciphertext.
- Public routes are limited to `/.well-known/devdash.json`, share links and signed webhooks.

Details: [`docs/PLAN.md` §11](docs/PLAN.md#11-security).

## Never commit secrets

Commits are scanned by gitleaks (pre-commit hook in `.githooks/`, and in CI). Server secrets live in `/etc/devdash/devdash.env` on the host, never in this repository.
