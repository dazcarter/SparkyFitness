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
- The bridge uses one-tap as a family **member** account (`FAMILYMEAL_USER_ID` in `.env`) and only does GETs.
  A dedicated FamilyMeal account with email+password is better; set `FAMILYMEAL_EMAIL`/`FAMILYMEAL_PASSWORD`.
- Sign-up is open on the tracker (LAN/VPN only). After the family has accounts, set
  `SPARKY_FITNESS_DISABLE_SIGNUP=true` in `/opt/tracker/.env` and `docker compose up -d`.
