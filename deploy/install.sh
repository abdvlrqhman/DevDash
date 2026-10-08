#!/usr/bin/env bash
# DevDash system setup (users, dirs, units, Caddy). Idempotent; activate.sh runs it on every deploy. Run as root.
# First install needs: --domain dev.example.com [--name "Space name"]
set -euo pipefail

DOMAIN="" NAME=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
REL="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/devdash/devdash.env
CERTS=/etc/caddy/certs

# Service user (owns data, never builds) and build user (runs npm, sees no secrets).
id devdash &>/dev/null || useradd --system --home-dir /var/lib/devdash --shell /usr/sbin/nologin devdash
id devdash-build &>/dev/null || useradd --system --create-home --home-dir /var/cache/devdash-build --shell /usr/sbin/nologin devdash-build
install -d -m 700 -o devdash -g devdash /var/lib/devdash
install -d -m 750 -o root -g devdash /etc/devdash
install -d -m 755 /opt/devdash/releases

if [[ ! -f $ENV_FILE ]]; then
  [[ -n $DOMAIN ]] || { echo "first install: pass --domain <domain>" >&2; exit 2; }
  (umask 027; cat > "$ENV_FILE" <<EOF
DEVDASH_ORIGIN=https://$DOMAIN
DEVDASH_SPACE_NAME=${NAME:-DevDash}
DEVDASH_DATA_DIR=/var/lib/devdash
DEVDASH_PORT=8787
DEVDASH_MASTER_KEY=$(openssl rand -base64 32)
DEVDASH_TRUST_CF_IP=1
EOF
  )
  chown root:devdash "$ENV_FILE" && chmod 640 "$ENV_FILE"
  echo "created $ENV_FILE (back it up: the master key decrypts every member's 2FA secret)"
fi
DOMAIN=$(sed -n 's|^DEVDASH_ORIGIN=https://||p' "$ENV_FILE")

install -m 644 "$REL/deploy/systemd/devdash-server.service" /etc/systemd/system/devdash-server.service
install -m 755 "$REL/deploy/devdash-cli" /usr/local/bin/devdash

# Caddy: domain via env, TLS mode from what's on disk.
install -m 644 "$REL/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=DEVDASH_DOMAIN=%s\n' "$DOMAIN" > /etc/systemd/system/caddy.service.d/devdash.conf
if [[ -f $CERTS/origin.crt && -f $CERTS/origin.key ]]; then
  {
    echo "tls $CERTS/origin.crt $CERTS/origin.key {"
    # Authenticated Origin Pulls: only add once it's switched on in Cloudflare, or every request fails.
    if [[ -f $CERTS/cloudflare-origin-pull-ca.pem ]]; then
      printf '\tclient_auth {\n\t\tmode require_and_verify\n\t\ttrust_pool file %s\n\t}\n' "$CERTS/cloudflare-origin-pull-ca.pem"
    fi
    echo "}"
  } > /etc/caddy/devdash-tls.caddy
else
  echo "tls internal" > /etc/caddy/devdash-tls.caddy # until the Cloudflare origin certificate is installed
fi
DEVDASH_DOMAIN=$DOMAIN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

systemctl daemon-reload
systemctl enable -q devdash-server caddy
