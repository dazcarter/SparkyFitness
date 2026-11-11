// FamilyMeal -> SparkyFitness bridge. Zero dependencies (Node 24: node:http, node:sqlite, fetch).
// Reads FamilyMeal over its HTTP API only (never its database), works out per-serving nutrition,
// and logs portions into the signed-in SparkyFitness user's diary using that user's own session.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as N from './nutrition.mjs';

const ENV = process.env;
const PORT = Number(ENV.PORT || 8080);
const SPARKY = ENV.SPARKY_INTERNAL_URL || 'http://sparkyfitness-server:3010';
const FM = (ENV.FAMILYMEAL_URL || 'https://meals.carterhome.com.au').replace(/\/$/, '');
const SYNC_HOURS = Number(ENV.SYNC_HOURS || 6);
const FM_GAP_MS = Number(ENV.FAMILYMEAL_REQUEST_GAP_MS || 1200); // FamilyMeal nginx allows 60 req/min
const APP_DIR = new URL('..', import.meta.url).pathname;

N.loadAusnut(ENV.AUSNUT_PATH || `${APP_DIR}data/ausnut.json`);
const INDEX = readFileSync(`${APP_DIR}public/index.html`);

// ---------------------------------------------------------------- storage
const db = new DatabaseSync(ENV.DB_PATH || '/data/bridge.db');
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, title TEXT, servings REAL, updated_at TEXT,
  image_url TEXT, ingredients TEXT, fetched_at TEXT, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS matches (recipe_id TEXT, ing_id TEXT, line_sig TEXT, source TEXT, ref TEXT, name TEXT,
  per100 TEXT, grams REAL, how TEXT, confident INTEGER, manual INTEGER DEFAULT 0, PRIMARY KEY (recipe_id, ing_id));
CREATE TABLE IF NOT EXISTS corrections (key TEXT PRIMARY KEY, source TEXT, ref TEXT, name TEXT, per100 TEXT,
  updated_at TEXT);
CREATE TABLE IF NOT EXISTS user_foods (user_id TEXT, recipe_id TEXT, food_id TEXT, variant_id TEXT, sig TEXT,
  PRIMARY KEY (user_id, recipe_id));
`);
const q = (sql) => db.prepare(sql);
// Matching logic changed: forget automatic matches (hand corrections stay); rematchAll() redoes them at startup.
const MATCHER_CHANGED = db.prepare('PRAGMA user_version').get().user_version !== N.MATCHER_VERSION;
if (MATCHER_CHANGED) {
  db.exec("UPDATE matches SET line_sig='' WHERE manual=0"); // old values stay visible until re-matched
  db.exec(`PRAGMA user_version=${N.MATCHER_VERSION}`);
}

// ---------------------------------------------------------------- FamilyMeal client (read only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fmCookies = '';
let fmLast = 0;
async function fmThrottle() {
  const wait = fmLast + FM_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  fmLast = Date.now();
}
const cookieHeader = (res) =>
  (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

async function fmLogin() {
  await fmThrottle();
  const r1 = await fetch(`${FM}/api/auth/csrf`);
  const jar = cookieHeader(r1);
  const { csrfToken } = await r1.json();
  const body = new URLSearchParams({ csrfToken, json: 'true' });
  let provider;
  if (ENV.FAMILYMEAL_EMAIL) {
    provider = 'credentials';
    body.set('email', ENV.FAMILYMEAL_EMAIL);
    body.set('password', ENV.FAMILYMEAL_PASSWORD || '');
  } else if (ENV.FAMILYMEAL_USER_ID) {
    provider = 'one-tap'; // FamilyMeal's own passwordless family-member login
    body.set('userId', ENV.FAMILYMEAL_USER_ID);
  } else throw new Error('FamilyMeal login not configured (FAMILYMEAL_EMAIL/PASSWORD or FAMILYMEAL_USER_ID)');
  await fmThrottle();
  const r2 = await fetch(`${FM}/api/auth/callback/${provider}`, {
    method: 'POST', redirect: 'manual', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
  });
  const session = cookieHeader(r2);
  if (!/session-token/.test(session)) throw new Error(`FamilyMeal login failed (HTTP ${r2.status})`);
  fmCookies = session;
}

async function fmGet(path, retry = true) {
  if (!fmCookies) await fmLogin();
  await fmThrottle();
  const r = await fetch(`${FM}${path}`, { headers: { Cookie: fmCookies } });
  if (r.status === 401 && retry) { fmCookies = ''; return fmGet(path, false); }
  if (r.status === 429 || r.status === 503) { await sleep(15000); return fmGet(path, retry); }
  if (!r.ok) throw new Error(`FamilyMeal ${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- matching
const lineSig = (i) => `${i.amount}|${i.unit || ''}|${i.item}`;
const corrKey = (item) => N.cleanItem(item).key;

async function bestMatch(ing) {
  const corr = q('SELECT * FROM corrections WHERE key=?').get(corrKey(ing.item));
  if (corr) return { source: corr.source, ref: corr.ref, name: corr.name, per100: JSON.parse(corr.per100), corrected: true };
  const [a] = N.searchAusnut(ing.item, 1);
  if (a && (a.score >= N.MATCH_THRESHOLD || a.full)) return a;
  const [o] = await N.offSearch(ing.item, 1);
  return o ? { ...o, weak: true } : a ? { ...a, weak: true } : null;
}

async function matchRecipe(r) {
  const ings = JSON.parse(r.ingredients || '[]');
  const keep = new Set();
  for (const ing of ings) {
    keep.add(ing.id);
    const old = q('SELECT * FROM matches WHERE recipe_id=? AND ing_id=?').get(r.id, ing.id);
    if (old && old.line_sig === lineSig(ing)) continue; // unchanged line keeps its (possibly corrected) match
    const m = await bestMatch(ing);
    const food = m?.source === 'ausnut' ? N.ausnutById(m.ref) : null;
    const g = N.toGrams(ing.amount, ing.unit, ing.item, food);
    q(`INSERT OR REPLACE INTO matches (recipe_id, ing_id, line_sig, source, ref, name, per100, grams, how, confident, manual)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(r.id, ing.id, lineSig(ing), m?.source || 'none', m?.ref || null,
      m?.name || 'No match', JSON.stringify(m?.per100 || { kcal: 0, protein: 0, carbs: 0, fat: 0 }),
      g.grams, g.how, m && !m.weak && g.confident ? 1 : 0);
  }
  for (const m of q('SELECT ing_id FROM matches WHERE recipe_id=?').all(r.id))
    if (!keep.has(m.ing_id)) q('DELETE FROM matches WHERE recipe_id=? AND ing_id=?').run(r.id, m.ing_id);
}

function recipeView(r) {
  const ings = JSON.parse(r.ingredients || '[]');
  const ms = Object.fromEntries(q('SELECT * FROM matches WHERE recipe_id=?').all(r.id).map((m) => [m.ing_id, m]));
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const lines = ings.map((i) => {
    const m = ms[i.id];
    const n = m ? N.scale(JSON.parse(m.per100), m.grams) : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    for (const k in total) total[k] += n[k];
    // Only ask people to check guesses that move the total (>= 25 kcal) or that found nothing at all.
    const review = !m || m.source === 'none' || (!m.confident && n.kcal >= 25);
    return { id: i.id, amount: i.amount, unit: i.unit, item: i.item, review, match: m ? { source: m.source, ref: m.ref,
      name: m.name, grams: m.grams, how: m.how, confident: !!m.confident, manual: !!m.manual } : null,
      nutrition: round(n) };
  });
  const servings = r.servings || 1;
  const per = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v / servings]));
  return { id: r.id, title: r.title, servings, updatedAt: r.updated_at, imageUrl: r.image_url,
    total: round(total), perServing: round(per), needsReview: lines.filter((l) => l.review).length, lines };
}
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));

// ---------------------------------------------------------------- sync
const status = { running: false, lastRun: null, lastError: null, recipes: 0, changed: 0 };
async function fetchDetail(id) {
  const d = await fmGet(`/api/recipes/${encodeURIComponent(id)}`);
  q(`UPDATE recipes SET title=?, servings=?, updated_at=?, image_url=?, ingredients=?, fetched_at=? WHERE id=?`)
    .run(d.title, d.baseServings || 1, d.updatedAt, d.imageUrl || null,
      JSON.stringify((d.ingredients || []).map(({ id: iid, amount, unit, item }) => ({ id: iid, amount, unit, item }))),
      new Date().toISOString(), id);
  await matchRecipe(q('SELECT * FROM recipes WHERE id=?').get(id));
}

async function syncAll() {
  if (status.running) return status;
  Object.assign(status, { running: true, lastError: null, changed: 0 });
  try {
    const list = await fmGet('/api/recipes');
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      const cur = q('SELECT updated_at, ingredients FROM recipes WHERE id=?').get(r.id);
      if (!cur) q('INSERT INTO recipes (id, title, servings, updated_at, image_url) VALUES (?,?,?,?,?)')
        .run(r.id, r.title, r.baseServings || 1, null, r.imageUrl || null);
      q('UPDATE recipes SET deleted=0, title=?, image_url=? WHERE id=?').run(r.title, r.imageUrl || null, r.id);
      if (!cur || cur.updated_at !== r.updatedAt || !cur.ingredients) { await fetchDetail(r.id); status.changed++; }
    }
    for (const r of q('SELECT id FROM recipes WHERE deleted=0').all())
      if (!seen.has(r.id)) q('UPDATE recipes SET deleted=1 WHERE id=?').run(r.id);
    status.recipes = seen.size;
  } catch (e) {
    status.lastError = String(e.message || e);
    console.error('sync failed:', status.lastError);
  } finally {
    status.running = false;
    status.lastRun = new Date().toISOString();
  }
  return status;
}

// ---------------------------------------------------------------- SparkyFitness (as the signed-in user)
const sessions = new Map(); // cookie hash -> { userId, name, until }
async function sparkyUser(req) {
  const cookie = req.headers.cookie || '';
  if (!cookie) return null;
  const k = createHash('sha256').update(cookie).digest('hex');
  const hit = sessions.get(k);
  if (hit && hit.until > Date.now()) return hit;
  const r = await fetch(`${SPARKY}/api/auth/get-session`, { headers: { cookie } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j?.user) return null;
  const u = { userId: j.user.id, name: j.user.name, cookie, until: Date.now() + 60_000 };
  sessions.set(k, u);
  return u;
}

async function sparky(u, method, path, body) {
  const r = await fetch(`${SPARKY}/api${path}`, {
    method, headers: { cookie: u.cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SparkyFitness ${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Make sure this user has a SparkyFitness food for the recipe (1 serving = 1 portion) with current values.
async function ensureFood(u, view) {
  const p = view.perServing;
  const fields = { serving_size: 1, serving_unit: 'serving', calories: p.kcal, protein: p.protein, carbs: p.carbs, fat: p.fat };
  const sig = JSON.stringify([view.title, fields]);
  const have = q('SELECT * FROM user_foods WHERE user_id=? AND recipe_id=?').get(u.userId, view.id);
  if (have) {
    if (have.sig === sig) return have;
    try {
      await sparky(u, 'PUT', `/foods/food-variants/${have.variant_id}`, { food_id: have.food_id, ...fields, is_default: true });
      await sparky(u, 'PUT', `/foods/${have.food_id}`, { name: view.title });
      q('UPDATE user_foods SET sig=? WHERE user_id=? AND recipe_id=?').run(sig, u.userId, view.id);
      return have;
    } catch (e) {
      console.warn('food update failed, recreating:', e.message); // e.g. the user deleted it in SparkyFitness
    }
  }
  const f = await sparky(u, 'POST', '/foods', {
    name: view.title, brand: 'FamilyMeal', is_custom: true, provider_type: 'familymeal',
    provider_external_id: view.id, ...fields,
  });
  const row = { food_id: f.id, variant_id: f.default_variant.id };
  q('INSERT OR REPLACE INTO user_foods VALUES (?,?,?,?,?)').run(u.userId, view.id, row.food_id, row.variant_id, sig);
  return row;
}

// ---------------------------------------------------------------- HTTP
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});
const todayPerth = () => new Date().toLocaleDateString('en-CA', { timeZone: ENV.TZ || 'Australia/Perth' });

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/familymeal/, '') || '/';
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(INDEX); }
  if (p === '/health') return json(res, 200, { ok: true, ...status });
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  const u = await sparkyUser(req);
  if (!u) return json(res, 401, { error: 'Sign in to SparkyFitness first' });
  let m;

  if (p === '/api/me') return json(res, 200, { name: u.name, sync: status });
  if (p === '/api/sync' && req.method === 'POST') { syncAll(); return json(res, 202, status); }
  if (p === '/api/recipes' && req.method === 'GET') {
    const s = `%${(url.searchParams.get('q') || '').toLowerCase()}%`;
    const rows = q(`SELECT * FROM recipes WHERE deleted=0 AND ingredients IS NOT NULL AND lower(title) LIKE ? ORDER BY title`).all(s);
    return json(res, 200, rows.map((r) => { const v = recipeView(r); delete v.lines; return v; }));
  }
  if ((m = p.match(/^\/api\/recipes\/([^/]+)$/)) && req.method === 'GET') {
    const r = q('SELECT * FROM recipes WHERE id=?').get(m[1]);
    return r ? json(res, 200, recipeView(r)) : json(res, 404, { error: 'no such recipe' });
  }
  if ((m = p.match(/^\/api\/recipes\/([^/]+)\/refresh$/)) && req.method === 'POST') {
    if (!q('SELECT 1 FROM recipes WHERE id=?').get(m[1])) return json(res, 404, { error: 'no such recipe' });
    await fetchDetail(m[1]);
    return json(res, 200, recipeView(q('SELECT * FROM recipes WHERE id=?').get(m[1])));
  }
  if ((m = p.match(/^\/api\/recipes\/([^/]+)\/lines\/([^/]+)$/)) && req.method === 'PUT') {
    const [, rid, iid] = m;
    const b = await readBody(req);
    const r = q('SELECT * FROM recipes WHERE id=?').get(rid);
    const ing = r && JSON.parse(r.ingredients || '[]').find((i) => i.id === iid);
    if (!ing) return json(res, 404, { error: 'no such ingredient' });
    const cur = q('SELECT * FROM matches WHERE recipe_id=? AND ing_id=?').get(rid, iid);
    let { source, ref, name, per100 } = cur;
    if (b.source === 'ausnut') {
      const f = N.ausnutById(String(b.ref));
      if (!f) return json(res, 400, { error: 'unknown AUSNUT id' });
      ({ source, ref, name } = { source: 'ausnut', ref: f.id, name: f.name });
      per100 = JSON.stringify({ kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat });
    } else if (b.source === 'off' || b.source === 'custom') {
      const v = b.per100 || {};
      if (![v.kcal, v.protein, v.carbs, v.fat].every((x) => Number.isFinite(Number(x)) && Number(x) >= 0))
        return json(res, 400, { error: 'per100 needs kcal, protein, carbs, fat' });
      ({ source, ref, name } = { source: b.source, ref: String(b.ref || ''), name: String(b.name || 'Custom').slice(0, 200) });
      per100 = JSON.stringify({ kcal: +v.kcal, protein: +v.protein, carbs: +v.carbs, fat: +v.fat });
    }
    const grams = b.grams != null ? Number(b.grams) : cur.grams;
    if (!Number.isFinite(grams) || grams < 0 || grams > 20000) return json(res, 400, { error: 'grams out of range' });
    const how = b.grams != null && Number(b.grams) !== cur.grams ? `${grams} g (set by hand)` : cur.how;
    q(`UPDATE matches SET source=?, ref=?, name=?, per100=?, grams=?, how=?, confident=1, manual=1 WHERE recipe_id=? AND ing_id=?`)
      .run(source, ref, name, per100, grams, how, rid, iid);
    if (b.remember !== false && b.source) // reuse this food choice for the same ingredient in every recipe
      q('INSERT OR REPLACE INTO corrections VALUES (?,?,?,?,?,?)').run(corrKey(ing.item), source, ref, name, per100, new Date().toISOString());
    return json(res, 200, recipeView(r));
  }
  if (p === '/api/nutrition-search') {
    const text = url.searchParams.get('q') || '';
    const [a, o] = await Promise.all([N.searchAusnut(text, 8), url.searchParams.get('off') === '0' ? [] : N.offSearch(text, 5)]);
    return json(res, 200, [...a, ...o]);
  }
  if ((m = p.match(/^\/api\/recipes\/([^/]+)\/log$/)) && req.method === 'POST') {
    const b = await readBody(req);
    const portions = Number(b.portions);
    if (!(portions > 0 && portions <= 20)) return json(res, 400, { error: 'portions must be between 0 and 20' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : todayPerth();
    const meal = ['breakfast', 'lunch', 'dinner', 'snacks'].includes(b.meal_type) ? b.meal_type : 'dinner';
    const r = q('SELECT * FROM recipes WHERE id=?').get(m[1]);
    if (!r) return json(res, 404, { error: 'no such recipe' });
    const view = recipeView(r);
    const food = await ensureFood(u, view);
    const entry = await sparky(u, 'POST', '/food-entries', {
      food_id: food.food_id, variant_id: food.variant_id, quantity: portions, unit: 'serving', meal_type: meal, entry_date: date,
    });
    return json(res, 201, { ok: true, entryId: entry.id, date, meal, portions,
      logged: round(Object.fromEntries(Object.entries(view.perServing).map(([k, v]) => [k, v * portions]))) });
  }
  return json(res, 404, { error: 'not found' });
}

http.createServer((req, res) => route(req, res).catch((e) => {
  console.error(e);
  if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
})).listen(PORT, () => console.log(`familymeal-bridge on :${PORT}`));

async function rematchAll() {
  for (const r of q('SELECT * FROM recipes WHERE ingredients IS NOT NULL').all()) await matchRecipe(r);
  console.log('re-matched all recipes for matcher version', N.MATCHER_VERSION);
}
setTimeout(async () => { if (MATCHER_CHANGED) await rematchAll(); await syncAll(); }, 5000);
setInterval(syncAll, SYNC_HOURS * 3600 * 1000);
