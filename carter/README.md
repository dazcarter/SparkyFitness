# Carter household tracker (SparkyFitness + FamilyMeal bridge)

Family calorie, weight and exercise tracker at **https://tracker.carterhome.com.au** (home LAN / WireGuard only).
Upstream SparkyFitness images run unmodified; everything household-specific lives in this `carter/` folder,
so `git merge upstream/main` never conflicts.

## Where things live

| What | Where |
|---|---|
| Container | Proxmox **CT 107** `tracker`, Debian 13, 2 cores / 2 GB, 24 GB on local-zfs, 192.168.0.52 (MAC BC:24:11:7A:C4:52, DHCP reservation `tracker-ct107`) |
| Compose stack | `/opt/tracker` in CT 107 (copy of this folder) + `.env` (secrets, never committed) |
| Data | `/opt/tracker/data/{postgresql,uploads,backup,bridge,pgdump}` |
| HTTPS | nginx (`proxy` service) with the OPNsense Let's Encrypt cert (`/opt/tracker/certs`) |
| DNS | AdGuard rewrite `tracker.carterhome.com.au -> 192.168.0.52` (no public DNS record) |
| Cert SAN | OPNsense ACME cert `664d0455…` now includes `tracker.carterhome.com.au` |
| FamilyMeal bridge | `familymeal-bridge/` — UI at `/familymeal/`, state in `data/bridge/bridge.db` |
| HA sensors | `home-assistant/tracker.yaml` (not installed — see below) |
| Throwaway test stack | `test/` — loopback-only copy for testing with test accounts |

Services: `sparkyfitness-db` (Postgres 18), `sparkyfitness-server`, `sparkyfitness-frontend` (pinned `v1.12.1`),
`familymeal-bridge` (Node 24, no dependencies), `proxy` (nginx 1.29). SparkyFitness built-ins cover weight and
measurements, barcode scanning (Open Food Facts), calorie/macro targets, exercise, Strava, Health Connect and backups.

## FamilyMeal recipe import (`/familymeal/`)

- Reads FamilyMeal **only over its HTTP API** (`/api/recipes`, `/api/recipes/:id`), never its SQLite DB.
  Login: `FAMILYMEAL_EMAIL`+`FAMILYMEAL_PASSWORD`, or `FAMILYMEAL_USER_ID` (FamilyMeal's passwordless family-member
  login). Requests are spaced 1.2 s apart because FamilyMeal's nginx allows 60/min.
- Every ingredient line (amount, unit, item) is matched to **AUSNUT 2023** (FSANZ, `data/ausnut.json`, built by
  `tools/build_ausnut.py`) and falls back to **Open Food Facts** (Australian products) when AUSNUT has no good match.
  Units become grams with Australian measures (tbsp = 20 ml, cup = 250 ml) and AUSNUT densities / piece weights.
- Whole recipe ÷ `baseServings` = per-serving kcal, protein, carbs, fat.
- Logging: pick portions (decimals OK), meal and date → the bridge creates/updates a SparkyFitness food
  "<recipe>" (brand FamilyMeal, 1 serving = 1 portion) in **your** library and adds the diary entry, using your own
  SparkyFitness session (same-origin cookie). The food also shows up in normal SparkyFitness search afterwards.
- Review: orange lines are guesses worth ≥ 25 kcal. Tap one to search AUSNUT/OFF, enter per-100 g values, or set grams.
  A food choice is remembered for that ingredient in every recipe; a grams change applies to that line.
- Re-sync: every 6 h, on "Re-sync", or "Refresh from FamilyMeal" on one recipe. Only recipes whose `updatedAt`
  changed are re-fetched; changed lines are re-matched, hand-corrected unchanged lines are kept. Past diary entries
  keep their own snapshot; the next log uses the new values.
- Tests: `node familymeal-bridge/test/nutrition.test.mjs`.

## Phone setup (each person)

1. Connect to home Wi-Fi or WireGuard, open https://tracker.carterhome.com.au, **Sign Up**.
   The first account created becomes admin — Darren first.
2. Barcode scanning: Diary → add food → barcode icon (needs HTTPS, which this is).
3. FamilyMeal: https://tracker.carterhome.com.au/familymeal/ (add it to the home screen).
4. Xiaomi watch → Mi Fitness → Health Connect → SparkyFitness app:
   - Mi Fitness: Profile → Settings → Third-party data access / Health Connect → on, allow steps, workouts, sleep, weight.
   - Install SparkyFitness Android: `app-release.apk` from https://github.com/CodeWithCJ/SparkyFitness/releases
     (or the Google Play beta: join https://groups.google.com/g/sparkyfitness first).
   - In SparkyFitness web: Settings → API keys → create one (full scope) for the phone.
   - App: server `https://tracker.carterhome.com.au`, paste the key, then Health Connect → grant permissions → Sync.
5. Strava (optional): create an API app at https://www.strava.com/settings/api (callback domain
   `tracker.carterhome.com.au`), then SparkyFitness Settings → Integrations → Strava.

## Home Assistant sensors (optional)

`home-assistant/tracker.yaml` gives calories eaten / remaining / goal and latest weight per person.
Create a **read**-scope API key in SparkyFitness, add `tracker_api_key_darren_header: "Bearer <key>"` to HA
`secrets.yaml`, copy the file to `/config/packages/`, and reload REST entities. Not installed by the build (HA was
left untouched on purpose).

## Certificates

The cert is OPNsense's ACME cert (Cloudflare DNS-01), shared with meals/ha/pve. Copied in by hand on 2026-11-11,
valid to 8 Feb 2027. Automatic renewal path: OPNsense → `pve-cert-renew.sh` (Proxmox, 03:00) →
`tracker-cert-sync.sh` (Proxmox, 03:15, `/etc/cron.d/tracker-cert-sync`) → CT 107 + nginx reload.
**Blocked until** the Proxmox host's `pve-cert-renew` key is authorised on OPNsense again (it has been rejected
since early Oct, which is also why the Proxmox web UI cert expired 28 Oct). Fix: OPNsense → System → Access →
Users → root → Authorized keys, add the line from `cat /root/.ssh/id_opnsense.pub` on Proxmox (optionally prefixed
`from="192.168.0.2" `), then run `/usr/local/bin/pve-cert-renew.sh && /usr/local/bin/tracker-cert-sync.sh`.

## Backups

- `scripts/backup-db.sh` nightly 01:30 in CT 107 (`/etc/cron.d/tracker-backup`): `pg_dump` + bridge DB to
  `/opt/tracker/data/pgdump`, 14 days kept. Restore verified 2026-11-11 (138 tables, no errors).
- CT 107 is in the Proxmox 02:00 vzdump job (`all`), keep-last 3, then rclone to Google Drive.
- SparkyFitness also has its own backup in Settings → Admin.

### Restore the database
```sh
cd /opt/tracker && docker compose stop sparkyfitness-server familymeal-bridge
gunzip -c data/pgdump/sparkyfitness-YYYYMMDD-HHMM.sql.gz | docker exec -i sparkyfitness-db psql -U sparky -d sparkyfitness_db
cp data/pgdump/bridge-YYYYMMDD.db data/bridge/bridge.db   # optional
docker compose up -d
```

## Operations

```sh
ssh root@192.168.0.2 'pct exec 107 -- sh -c "cd /opt/tracker && docker compose ps"'
# update SparkyFitness: set SPARKY_VERSION=vX.Y.Z in .env, then
docker compose pull && docker compose up -d
# rebuild the bridge after changing carter/familymeal-bridge:
docker compose up -d --build familymeal-bridge
```

## Roll back / remove everything

1. `pct stop 107 && pct destroy 107` on Proxmox (or restore an earlier vzdump of it).
2. Proxmox: `rm /etc/cron.d/tracker-cert-sync /usr/local/bin/tracker-cert-sync.sh`.
3. OPNsense: restore `/conf/config.xml.bak-20261111-0822-tracker` and
   `/usr/local/AdGuardHome/AdGuardHome.yaml.bak-20261111-0822-tracker`, or by hand remove the AdGuard rewrite,
   the `tracker-ct107` DHCP reservation and `tracker.carterhome.com.au` from the ACME cert's alt names
   (`configctl dnsmasq restart`, `service adguardhome restart`).
4. Nothing was changed in FamilyMeal (VM 102) or Home Assistant (VM 100).
