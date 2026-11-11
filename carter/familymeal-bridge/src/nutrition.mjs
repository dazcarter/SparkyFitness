// Ingredient line -> nutrition. AUSNUT 2023 first (per 100 g), Open Food Facts fallback.
// Pure functions except offSearch(); covered by test/nutrition.test.mjs.
import { readFileSync } from 'node:fs';

const STOP = new Set(('a an and or of to for the with in on into plus extra about approx ' +
  'large small medium big fresh freshly finely roughly thinly thickly chopped diced sliced minced ' +
  'crushed grated shredded smashed peeled trimmed halved quartered torn picked drained rinsed ' +
  'washed cut cubed julienned softened melted warmed beaten divided optional season seasoning taste ' +
  'serve serving garnish needed some good quality store bought packet pkt pack sachet tin can jar ' +
  'each whole leaves leaf sprig sprigs bunch stalk stalks head heads piece pieces cup cups ' +
  'tbsp tsp g kg ml l splash splashes dash pinch handful knob shot rasher rashers punnet slices slice ' +
  'shallow deep frying cooking brushing drizzling greasing pan room temperature at cold hot ' +
  'boneless skinless skin bone bones on off low reduced sea ripe baby clove stick sticks homemade').split(' '));
// salt-reduced etc. are still matched loosely; "hot" is kept out because it rarely changes nutrition.

const SYN = {
  chili: 'chilli', chilies: 'chilli', chillies: 'chilli', scallion: 'spring', scallions: 'spring',
  shallots: 'shallot', capsicums: 'capsicum', zucchinis: 'zucchini', coriander: 'coriander',
  cilantro: 'coriander', mince: 'mince', ground: 'mince', yoghurt: 'yoghurt', yogurt: 'yoghurt',
  parmigiano: 'parmesan', courgette: 'zucchini', aubergine: 'eggplant', prawns: 'prawn',
tortillas: 'tortilla', breadcrumbs: 'breadcrumb', noodles: 'noodle',
  fillets: 'fillet', pappardelle: 'pasta', penne: 'pasta', fettuccine: 'pasta', fettucine: 'pasta',
  linguine: 'pasta', rigatoni: 'pasta', fusilli: 'pasta', tagliatelle: 'pasta', orecchiette: 'pasta',
  farfalle: 'pasta', spaghetti: 'pasta', tonnarelli: 'pasta', bucatini: 'pasta',
  pecorino: 'parmesan', peppercorns: 'pepper', peppercorn: 'pepper', kosher: 'table', macaroni: 'pasta', lasagne: 'lasagne', thighs: 'thigh', breasts: 'breast', tomatoes: 'tomato', potatoes: 'potato',
  leaves: 'leaf', cloves: 'clove', eggs: 'egg', onions: 'onion', berries: 'berry',
};

export function stem(w) {
  if (SYN[w]) return SYN[w];
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

const words = (s) => s.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);

// "large brown onions, sliced (400g each)" -> { key: "brown onion", size: "large", gramsEach: 400 }
export function cleanItem(item) {
  const raw = String(item || '').toLowerCase();
  const each = raw.match(/\((\d+(?:\.\d+)?)\s*(g|ml)\b[^)]*\)/);
  let s = raw.replace(/\([^)]*\)/g, ' ');
  s = s.split(',')[0];
  // "chicken or vegetable stock" -> "chicken stock"; "beef chuck or blade roast" -> "beef chuck"
  const alt = s.split(/\s+or\s+/);
  if (alt.length > 1) {
    const first = alt[0].trim().split(/\s+/);
    const second = alt[1].trim().split(/\s+/);
    s = first.length === 1 && second.length > 1 ? [first[0], ...second.slice(1)].join(' ') : alt[0];
  }
  s = s.replace(/\bto (serve|taste|season)\b.*/, '');
  const size = (raw.match(/\b(small|medium|large)\b/) || [])[1] || null;
  const toks = words(s).filter((w) => !STOP.has(w)).map(stem).filter((w) => !STOP.has(w));
  return { key: toks.join(' '), tokens: toks, size, gramsEach: each ? Number(each[1]) : null };
}

let AUSNUT = [];
export function loadAusnut(path) {
  AUSNUT = JSON.parse(readFileSync(path, 'utf8')).map((f) => {
    const parts = f.name.toLowerCase().split(',').map((p) => words(p).map(stem));
    return { ...f, tokens: new Set(parts.flat()), head: parts[0] };
  });
  return AUSNUT.length;
}
export const ausnutById = (id) => AUSNUT.find((f) => f.id === id);

// Forms that change nutrition a lot; only pick them when the recipe line says so.
const FORMS = new Set(['dried', 'powder', 'dehydrated', 'concentrate', 'condensed', 'mix', 'freeze']);
const PREPARED = new Set(['cooked', 'fried', 'baked', 'roasted', 'grilled', 'boiled', 'stewed', 'casseroled',
  'microwaved', 'poached', 'steamed', 'canned', 'commercial', 'homemade', 'takeaway', 'battered', 'crumbed',
  'with', 'sauce', 'prepared', 'reconstituted', 'flavoured', 'sweetened', 'meal', 'dish', 'mixed']);

export function scoreAusnut(q, f) {
  if (!q.tokens.length) return 0;
  let hit = 0;
  for (const t of q.tokens) if (f.tokens.has(t)) hit++;
  if (!hit) return 0;
  let s = hit / q.tokens.length;
  // The food's head noun (before the first comma) should be one of the query words.
  if (f.head.some((t) => q.tokens.includes(t))) s += 0.3;
  // Extra words in the food's head ("Cream of tartar", "Pasta in tomato sauce") mean a different food.
  s -= f.head.filter((t) => !q.tokens.includes(t)).length * 0.15;
  const extra = [...f.tokens].filter((t) => !q.tokens.includes(t));
  for (const t of extra) if (PREPARED.has(t)) s -= 0.12;
  for (const t of extra) if (FORMS.has(t)) s -= 0.25;
  if (f.tokens.has('raw') || f.tokens.has('uncooked') || f.tokens.has('dry')) s += 0.1;
  s -= extra.length * 0.015;
  return s;
}

// Household staples whose generic AUSNUT entry the scorer can't pick on words alone.
const ALIASES = [
  [/\bstock (powder|cube)|\b(powder|cube) stock|stock powder/, 'Stock, dry powder or cube'],
  [/\bstock\b|\bbroth\b/, 'Stock, liquid, all flavours, prepared'],
  [/^(neutral|neutral flavoured|neutral flavored|cooking|light)? ?oil$/, 'Oil, not further defined'],
  [/^salt( pepper| black pepper)?$|^salt cracked black pepper$/, 'Salt, table, iodised'],
  [/^water$|boiling water|cold water/, 'Water, tap'],
  [/^(brown |yellow |white )?onion$/, 'Onion, mature, brown skinned, peeled, raw'],
  [/^(white |long grain |jasmine |basmati )?rice$/, 'Rice, white, uncooked'],
  [/^pasta$|^pasta pasta$|^dried pasta$|^egg pasta$/, 'Pasta, egg, plain, uncooked'],
  [/^(plain )?flour$|^all purpose flour$/, 'Flour, wheat, white, plain'],
  [/^(white |caster |granulated )?sugar$/, 'Sugar, white, granulated or lump'],
  [/^(full cream |whole )?milk$/, 'Milk, cow, fluid, regular fat (~3.5%)'],
  [/^(tasty |grated |bitey |shredded )?(cheddar|cheese)( cheese)?$/, 'Cheese, cheddar, natural, plain'],
  [/^coconut milk$/, 'Coconut, milk, canned'],
  [/^(black )?pepper$|^black pepper$/, 'Pepper, black or white, ground'],
  [/^(lemon|lime) juice$|^squeeze lemon juice$|^juice lemon$/, 'Juice, lemon'],
  [/^bay$|^bay leaf$|^curry leaf$|^kaffir lime$|^makrut lime$/, 'Herbs, mixed, raw'],
];

export function searchAusnut(text, n = 8) {
  const q = cleanItem(text);
  const alias = ALIASES.find(([re]) => re.test(q.key));
  const pinned = alias && AUSNUT.find((f) => f.name.trim() === alias[1]);
  return AUSNUT.map((f) => ({ f, s: f === pinned ? 2 : scoreAusnut(q, f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ f, s }) => ({ source: 'ausnut', ref: f.id, name: f.name, score: +s.toFixed(3), per100: per100(f),
      // every word of the ingredient appears in the AUSNUT name ("mozzarella" -> "Cheese, mozzarella")
      full: s === 2 || q.tokens.every((t) => f.tokens.has(t)) }));
}

const per100 = (f) => ({ kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat });

// Australian measures. Volume in ml, converted with the food's density when known.
const ML = { ml: 1, l: 1000, litre: 1000, liter: 1000, tsp: 5, teaspoon: 5, tbsp: 20, tablespoon: 20,
  cup: 250, dash: 1, splash: 10, shot: 30 };
const G = { g: 1, gram: 1, kg: 1000, handful: 30, pinch: 0.5, knob: 15, bunch: 60, can: 400, tin: 400,
  rasher: 35, punnet: 250, jar: 300, packet: 250, 'large packet': 500, sachet: 40 };

function normUnit(u) {
  const x = String(u || '').toLowerCase().trim().replace(/\.$/, '');
  if (!x) return '';
  if (G[x] || ML[x]) return x;
  const known = (u) => G[u] !== undefined || ML[u] !== undefined;
  if (x.endsWith('es') && known(x.slice(0, -2))) return x.slice(0, -2);
  if (x.endsWith('s') && known(x.slice(0, -1))) return x.slice(0, -1);
  return x;
}

// Grams for one ingredient line. Returns { grams, how, confident }.
export function toGrams(amount, unit, item, food) {
  const a = Number(amount) || 1;
  const q = cleanItem(item);
  let u = normUnit(unit);
  // "2 splashes worcestershire" style: unit word lives in the item text.
  if (!u) {
    const m = String(item).toLowerCase().match(/^\s*(splash(?:es)?|dash(?:es)?|pinch(?:es)?|handfuls?|knobs?|cans?|tins?|jars?|packets?|sachets?|rashers?|punnets?)\b/);
    if (m) u = normUnit(m[1]);
  }
  if (q.gramsEach && (!u || ['can', 'tin', 'jar', 'packet', 'sachet'].includes(u)))
    return { grams: a * q.gramsEach, how: `${a} × ${q.gramsEach} g (from label)`, confident: true };
  if (u === 'g' || u === 'gram' || u === 'kg') return { grams: a * G[u], how: `${a * G[u]} g`, confident: true };
  if (G[u]) return { grams: a * G[u], how: `${a} ${u} ≈ ${G[u]} g each`, confident: false };
  if (ML[u]) {
    const d = food?.density || 1;
    const ml = a * ML[u];
    return { grams: ml * d, how: d === 1 ? `${ml} ml` : `${ml} ml × ${d} g/ml`, confident: !!food?.density || ['ml', 'l'].includes(u) };
  }
  // Counted items ("2 brown onions", "1 slice"): use an AUSNUT measure.
  const ms = (food?.measures || []).filter(([d]) => !/^(cup|tablespoon|teaspoon|density)/.test(d));
  if (ms.length) {
    const want = [u, q.size, 'medium'].filter(Boolean);
    const hit = want.map((w) => ms.find(([d]) => d.includes(w))).find(Boolean) || ms[0];
    return { grams: a * hit[1], how: `${a} × ${hit[0]} (${hit[1]} g)`, confident: true };
  }
  return { grams: a * 50, how: `${a} × 50 g (guess, no measure known)`, confident: false };
}

// Open Food Facts fallback (Australian products first). Values per 100 g.
export async function offSearch(text, n = 5) {
  const q = cleanItem(text).key || String(text);
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}` +
    `&search_simple=1&action=process&json=1&page_size=${n * 3}&tagtype_0=countries&tag_contains_0=contains&tag_0=australia` +
    '&fields=code,product_name,brands,nutriments';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'CarterTracker-FamilyMealBridge/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.products || [])
      .filter((p) => p.product_name && p.nutriments && p.nutriments['energy-kcal_100g'] != null)
      .slice(0, n)
      .map((p) => ({
        source: 'off', ref: p.code, name: `${p.product_name}${p.brands ? ` (${p.brands.split(',')[0]})` : ''}`,
        score: 0.5, per100: {
          kcal: +p.nutriments['energy-kcal_100g'] || 0, protein: +p.nutriments.proteins_100g || 0,
          carbs: +p.nutriments.carbohydrates_100g || 0, fat: +p.nutriments.fat_100g || 0,
        },
      }));
  } catch {
    return [];
  }
}

export const MATCHER_VERSION = 4; // bump to re-match every non-hand-corrected line
export const MATCH_THRESHOLD = 0.95; // below this AUSNUT score we also try Open Food Facts

export function scale(per100, grams) {
  const k = grams / 100;
  return { kcal: per100.kcal * k, protein: per100.protein * k, carbs: per100.carbs * k, fat: per100.fat * k };
}
