#!/bin/sh
# Build carter/patched/* from the pinned upstream server image + carter/patches/*.patch.
# Run in /opt/tracker after changing SPARKY_VERSION, before `docker compose up -d`.
# If a patch no longer applies, upstream changed that file: fix the patch (or drop it if upstream fixed the issue).
set -eu
cd "$(dirname "$0")/.."
V=$(grep -s '^SPARKY_VERSION=' .env | cut -d= -f2); V=${V:-v1.12.1}
IMG=codewithcj/sparkyfitness_server:$V
mkdir -p patched
docker run --rm --entrypoint cat "$IMG" /app/SparkyFitnessServer/integrations/swissfood/swissFoodService.ts > patched/swissFoodService.ts
patch --forward --quiet -p2 patched/swissFoodService.ts < patches/swissfood-lan.patch
echo "patched swissFoodService.ts for $IMG"
