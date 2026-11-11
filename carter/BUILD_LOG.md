# Build log — tracker.carterhome.com.au (2026-11-11, AWST)

- 07:5x Surveyed: SparkyFitness v1.12.1 already has barcode/OFF, weight, goals, exercise, Strava, Health Connect
  (via its Android app), Mealie/Tandoor recipe providers, backups. FamilyMeal API needs a NextAuth session; recipes
  carry `baseServings` + ingredient lines. Certs: OPNsense ACME (Cloudflare DNS-01, fixed SAN list), not nginx/LE on a box.
- 08:22 OPNsense (Darren OK'd): backups `config.xml.bak-20261111-0822-tracker`, `AdGuardHome.yaml.bak-…`;
  added `tracker.carterhome.com.au` to ACME cert alt names, AdGuard rewrite → 192.168.0.52, dnsmasq reservation
  `tracker-ct107`. Reissued cert (now to 8 Feb 2027, includes tracker). DNS verified from the LAN.
- 08:2x Found `pve-cert-renew` failing since early Oct (OPNsense rejects the Proxmox key) → Proxmox UI cert expired
  28 Oct. Re-authorising that key was blocked by the session's safety classifier; left for Darren (README).
- 08:3x Created CT 107 (Debian 13, unprivileged, nesting+keyctl, onboot), Docker 29.9 + compose v5.7.
- 08:4x Stack up with pinned v1.12.1 images; HTTPS verified (valid chain). First page load 200, /api/health UP.
- 08:5x Loopback test stack (`-p tracker-test`) + test account on localhost; verified food create, 1.5-serving
  entries, daily summary, Health Connect ingest (steps+weight via API key), read-only API key (HA) and write refusal.
- 09:0x Downloaded AUSNUT 2023 profiles + measures (FSANZ, CC BY 4.0) → `data/ausnut.json` (3,741 foods).
- Pulled FamilyMeal recipes read-only; its nginx returned 503s at ~84 fast requests (60/min limit) — bridge now
  spaces requests 1.2 s and backs off on 429/503. FamilyMeal stayed healthy.
- Matcher iterations v1→v4 on all 196 real recipes: fixed "x or y" items, form words (coconut milk ≠ powder),
  peppercorns/pecorino/pasta shapes, staple aliases (stock, oil, onion, rice…), densities, plural units; review
  flags limited to guesses ≥ 25 kcal. Result: 488 lines to check over 196 recipes, median 776 kcal/serving.
- Browser test on test stack: list, recipe view, correction (search + grams), log 1.5 portions → diary 870 kcal.
- Barcode lookup: Vegemite 9300650658516 → Open Food Facts, 190 kcal/100 g. Camera scan itself needs a phone.
- 09:3x Backups: nightly pg_dump cron in CT 107; restore into scratch DB verified (138 tables, 0 errors).
  Cert sync cron on Proxmox (skips until pve-cert-renew works). Production bridge deployed; test stack stopped.

## Not verified here (needs a phone)
- Camera barcode scanning in the phone browser.
- SparkyFitness Android app + Health Connect permissions + Mi Fitness → Health Connect.
- Strava (needs Darren's Strava API app).

## Security notes
- FamilyMeal's login page lists every user id, and its `one-tap` provider signs in with only an id (no role check
  server-side). It is LAN/VPN only (no public DNS), but anyone on the network can sign in as anyone, including the
  admin, by calling the API. Not changed (FamilyMeal is out of scope); worth fixing in FamilyMeal.
- The bridge now uses FamilyMeal's read-only Recipe API key (`FAMILYMEAL_API_KEY`), no FamilyMeal user login.
- Sign-up is open on the tracker (LAN/VPN only). After the family has accounts, set
  `SPARKY_FITNESS_DISABLE_SIGNUP=true` in `/opt/tracker/.env` and `docker compose up -d`.

- 09:5x Food search providers: bridge now also answers in Swiss-API format (AUSNUT, per 100 g) and Mealie format
  (FamilyMeal recipes). One-file patch `patches/swissfood-lan.patch` lets the Swiss provider reach the bridge on the compose
  network. Tested on the test stack via /api/v2/foods/search, deployed, added both to Darren's account, switched off
  Swiss/Canadian/Swedish/NIH supplement providers (Darren asked). Emulation paths 404 from outside.
- 19:27 (Darren OK'd) Re-added Proxmox `pve-cert-renew` key to OPNsense root (config.xml backup `…-1927-pvekey`,
  `from="192.168.0.2"`). pve-cert-renew + tracker-cert-sync ran clean; Proxmox UI and tracker certs valid to 8 Feb 2027.
- Darren tested search/barcode and phone sync. Added git remote `fork` = git@github.com:dazcarter/SparkyFitness.git;
  Darren created the fork; `carter` pushed to https://github.com/dazcarter/SparkyFitness (tracks `fork/carter`).
- 20:0x Darren asked for a FamilyMeal API. Built in FamilyMeal (VM 102, snapshot `pre-recipe-api-20261111` + DB copy
  `/root/fm-backups/familymeal-20261111-pre-api.db` first): read-only `/api/v1/recipes[/:id]` with a hashed household
  API key (Settings -> Recipe API), commit ee049fe on `redesign/sunday-table`, pushed. Bridge now uses
  `FAMILYMEAL_API_KEY` (one-tap login removed) and re-checks FamilyMeal on search (max once/min), so new recipes
  show up in search straight away. Verified: bad/missing key 401, SparkyFitness search as Darren returns recipes.
- Phone app: 10-min capture showed no requests from the phone at all (not reaching the tracker).
