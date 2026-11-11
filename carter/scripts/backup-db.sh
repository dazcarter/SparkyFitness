#!/bin/sh
# Nightly logical backup of the SparkyFitness Postgres DB (runs in CT 107 from /etc/cron.d/tracker-backup).
# Keeps 14 days in /opt/tracker/data/pgdump. CT 107 itself is also in the 02:00 Proxmox vzdump job.
# Restore: see carter/README.md ("Restore the database").
set -eu
OUT=/opt/tracker/data/pgdump
mkdir -p "$OUT"
F="$OUT/sparkyfitness-$(date +%Y%m%d-%H%M).sql.gz"
docker exec sparkyfitness-db pg_dump -U sparky -d sparkyfitness_db --clean --if-exists | gzip > "$F.tmp"
[ -s "$F.tmp" ] && mv "$F.tmp" "$F"
# The bridge state (matches + corrections) is a single SQLite file; copy it alongside.
cp /opt/tracker/data/bridge/bridge.db "$OUT/bridge-$(date +%Y%m%d).db" 2>/dev/null || true
find "$OUT" -type f -mtime +14 -delete
echo "$(date -Is) backup ok $(du -h "$F" | cut -f1)"
