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

- Reads FamilyMeal **only over its read-only Recipe API** (`/api/v1/recipes`, `/api/v1/recipes/:id`), never its
  SQLite DB. Auth: `FAMILYMEAL_API_KEY` in `.env` (FamilyMeal → Settings → Recipe API; generating a new key there
  breaks the bridge until `.env` is updated and `docker compose up -d familymeal-bridge` is run).
  Requests are spaced 1.2 s apart because FamilyMeal's nginx allows 60/min.
- New recipes: any search (SparkyFitness food search or `/familymeal/`) re-checks FamilyMeal at most once a minute,
  so a recipe added in FamilyMeal shows up on the next search.
- Every ingredient line (amount, unit, item) is matched to **AUSNUT 2023** (FSANZ, `data/ausnut.json`, built by
  `tools/build_ausnut.py`) and falls back to **Open Food Facts** (Australian products) when AUSNUT has no good match.
  Units become grams with Australian measures (tbsp = 20 ml, cup = 250 ml) and AUSNUT densities / piece weights.
- Whole recipe ÷ `baseServings` = per-serving kcal, protein, carbs, fat.
- Logging: pick portions (decimals OK), meal and date → the bridge creates/updates a SparkyFitness food
  "<recipe>" (brand FamilyMeal, 1 serving = 1 portion) in **your** library and adds the diary entry, using your own
  SparkyFitness session (same-origin cookie). The food also shows up in normal SparkyFitness search afterwards.
- Review: orange lines are guesses worth ≥ 25 kcal. Tap one to search AUSNUT/OFF, enter per-100 g values, or set grams.
  A food choice is remembered for that ingredient in every recipe; a grams change applies to that line.
- Re-sync: on search (above), every 6 h, on "Re-sync", or "Refresh from FamilyMeal" on one recipe. Only recipes whose `updatedAt`
  changed are re-fetched; changed lines are re-matched, hand-corrected unchanged lines are kept. Past diary entries
  keep their own snapshot; the next log uses the new values.
- Tests: `node familymeal-bridge/test/nutrition.test.mjs`.

## AUSNUT and FamilyMeal in SparkyFitness's own food search

No data is imported into SparkyFitness; the bridge answers live, like any other food provider.

- **AUSNUT 2023**: provider type *Swiss Food Database*, renamed "AUSNUT 2023", base URL
  `http://familymeal-bridge:8080/familymeal/ausnut`. The bridge speaks the Swiss API format (per 100 g).
  Upstream only lets that provider call public addresses, so `patches/swissfood-lan.patch` (mounted over the
  image's `swissFoodService.ts`) lets hosts in `SPARKY_LAN_FOOD_HOSTS` through and brands them "AUSNUT 2023".
  The UI has no base-URL field for this type, so add it for a new person with SQL / the repository (see below).
- **FamilyMeal**: provider type *Mealie*, base URL `http://familymeal-bridge:8080/familymeal/mealie`, any API key
  (e.g. `not-used`). Per-serving values come from the bridge's matching and corrections. Works for non-admins
  because `ALLOW_PRIVATE_NETWORK_FOOD_PROVIDERS=true`.
- `/familymeal/ausnut/*` and `/familymeal/mealie/*` are blocked in nginx (404 from outside the compose network).
- Darren's account has both (added 2026-11-11), and Swiss/Canadian/Swedish/NIH supplement providers switched off.
- Add both for another person (run in `/opt/tracker`, replace NAME):
  ```sh
  U=$(docker exec sparkyfitness-db psql -U sparky -d sparkyfitness_db -tAc "select id from public.\"user\" where name='NAME'")
  docker compose exec -T -e U=$U sparkyfitness-server node --import tsx --input-type=module -e '
  const r = await import("/app/SparkyFitnessServer/models/externalProviderRepository.ts");
  await r.createExternalDataProvider({ user_id: process.env.U, provider_name: "AUSNUT 2023", provider_type: "swissfood", base_url: "http://familymeal-bridge:8080/familymeal/ausnut", is_active: true });
  await r.createExternalDataProvider({ user_id: process.env.U, provider_name: "FamilyMeal", provider_type: "mealie", base_url: "http://familymeal-bridge:8080/familymeal/mealie", app_key: "not-used", is_active: true });
  process.exit(0);'
  ```
- After changing `SPARKY_VERSION`: `scripts/apply-patches.sh && docker compose up -d --force-recreate sparkyfitness-server`.
  If the patch fails, upstream changed that file. Upstreaming "honour the private-network setting for Swiss/CNF
  custom URLs" would let the patch go.
- Single-file bind mounts (`nginx/tracker.conf`, `patched/*.ts`) need `--force-recreate` on that service after the
  file is replaced, or the container keeps the old file.

## AI chat (Ask Sparky)

- Global AI service "Claude" (Anthropic, `claude-haiku-5-5`), key added by Darren in Admin → Global AI Settings
  (billed on his console.anthropic.com account).
- `patches/anthropic-websearch.patch` (mounted over `services/chatService.ts`) gives Claude Anthropic's server-side
  web search (max 3 searches per message, AU location); upstream only enables it for OpenAI GPT-6. Searches cost
  extra on the Anthropic bill (about US$10 per 1,000).
- The service's system prompt (edit in Admin → Global AI Settings) tells it to web-search restaurant/brand foods
  missing from the databases.

## Claude app connector (public, MCP + sign-in only) — 2026-11-12

- Public DNS `tracker.carterhome.com.au` CNAME → `ha-tunnel` (cloudflared-ha in CT 103, 192.168.0.50); tunnel ingress
  → `https://192.168.0.52` (no TLS verify). LAN/VPN still resolve to .52 via AdGuard, unchanged.
- nginx (`nginx/tracker.conf`, `geo $from_tunnel`) lets tunnel traffic reach only `/mcp`, `/.well-known/`,
  `/api/auth/`, `/api/identity/`, `/login`, `/oauth/consent` and static assets; everything else 404.
- Remote MCP OAuth on (`global_settings.mcp_oauth_enabled`), redirects limited to Claude's two callbacks.
  Approved apps: Settings → Connected MCP Applications (revoke there).
- Undo: delete the DNS record, remove the tracker entry from ha-tunnel (backup `/root/ha-tunnel-config-bak-20261112.json`
  on Proxmox), set `mcp_oauth_enabled=false`. Cloudflare token (tunnel edit) in `/root/.cf_tunnel_token` on Proxmox.

## Claude on Darren's PC (MCP)

- SparkyFitness serves MCP at `https://tracker.carterhome.com.au/mcp`.
- Full-access API key "Claude on Darren PC (MCP)", no expiry, created 2026-11-11 for Darren. Stored only on the PC:
  `~/.config/sparky/mcp-key`, Claude Code user config (`~/.claude.json`, server `sparky`), and
  `~/.config/Claude/claude_desktop_config.json` (via `npx mcp-remote`). Revoke in Settings → API Key Management.

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
Working again since 2026-11-11: the Proxmox `id_opnsense.pub` key (`pve-cert-renew@carterhome`, restricted
`from="192.168.0.2"`) was re-added to OPNsense root's authorized keys in `config.xml` (backup
`/conf/config.xml.bak-20261111-1927-pvekey`). If renewal breaks again, check
`ssh -i /root/.ssh/id_opnsense root@192.168.0.1 echo ok` from Proxmox.

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
