#!/usr/bin/env bash
# Allow HTTPS (443) only from Cloudflare's published IP ranges. Idempotent. Run as root.
set -euo pipefail

ranges="$(curl -fsSL https://www.cloudflare.com/ips-v4; echo; curl -fsSL https://www.cloudflare.com/ips-v6)"
[[ $(grep -c . <<<"$ranges") -gt 10 ]] || { echo "could not fetch Cloudflare ranges" >&2; exit 1; }

# ponytail: only adds ranges; Cloudflare rarely drops one. Diff and delete stale rules if that ever matters.
while read -r cidr; do
  [[ -n $cidr ]] && ufw allow proto tcp from "$cidr" to any port 443 comment cloudflare >/dev/null
done <<<"$ranges"
echo "cloudflare: $(grep -c . <<<"$ranges") ranges allowed on 443"
