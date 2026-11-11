#!/bin/sh
# Runs on the Proxmox host (cron 03:15, after pve-cert-renew at 03:00).
# The OPNsense ACME cert carries tracker.carterhome.com.au; pve-cert-renew installs it for pveproxy.
# This copies that same cert into CT 107 when it changes and reloads the tracker's nginx.
set -eu
SRC_CRT=/etc/pve/local/pveproxy-ssl.pem
SRC_KEY=/etc/pve/local/pveproxy-ssl.key
DST=/opt/tracker/certs
openssl x509 -in "$SRC_CRT" -noout -ext subjectAltName | grep -q tracker.carterhome.com.au || {
  echo "$(date -Is) skip: pveproxy cert has no tracker SAN (pve-cert-renew not pulling?)"; exit 0; }
if pct exec 107 -- cat "$DST/fullchain.pem" 2>/dev/null | cmp -s - "$SRC_CRT"; then
  echo "$(date -Is) unchanged"; exit 0
fi
pct push 107 "$SRC_CRT" "$DST/fullchain.pem" --perms 0644
pct push 107 "$SRC_KEY" "$DST/private.key" --perms 0600
pct exec 107 -- sh -c 'cd /opt/tracker && docker compose exec -T proxy nginx -s reload'
echo "$(date -Is) installed new cert in CT 107, expires $(openssl x509 -in "$SRC_CRT" -noout -enddate | cut -d= -f2)"
