// Run: node test/nutrition.test.mjs   (exits non-zero on failure)
import assert from 'node:assert/strict';
import * as n from '../src/nutrition.mjs';

n.loadAusnut(new URL('../data/ausnut.json', import.meta.url).pathname);
const top = (t) => n.searchAusnut(t, 1)[0]?.name || '';

// matching
assert.match(top('large brown onions, sliced'), /^Onion, mature, brown/);
assert.match(top('garlic cloves, smashed'), /^Garlic/);
assert.match(top('chicken or vegetable stock'), /^Stock, liquid/);
assert.match(top('500 g beef mince'), /^Beef, mince/);
assert.match(top('thickened cream'), /^Cream/);
assert.match(top('bay leaves'), /^Herbs, mixed/);
assert.match(top('penne pasta'), /^Pasta/);
assert.match(top('egg'), /^Egg, chicken, whole, raw/);

// grams
const egg = n.ausnutById(n.searchAusnut('egg', 1)[0].ref);
assert.equal(n.toGrams(2, null, 'large eggs', egg).grams, 102); // 2 × 51 g
assert.equal(n.toGrams(1.4, 'kg', 'beef roast', null).grams, 1400);
assert.equal(n.toGrams(2, 'tbsp', 'water', { density: 1 }).grams, 40); // AU tablespoon = 20 ml
assert.equal(n.toGrams(2, 'cans', 'chickpeas (400g each), drained', null).grams, 800);
assert.equal(n.toGrams(2, null, 'splashes worcestershire sauce', null).grams, 20);
assert.equal(n.toGrams(1, null, 'mystery thing', null).confident, false);

// scaling
assert.deepEqual(n.scale({ kcal: 100, protein: 10, carbs: 20, fat: 5 }, 250), { kcal: 250, protein: 25, carbs: 50, fat: 12.5 });
console.log('nutrition tests passed');

// regressions found on real FamilyMeal recipes
assert.match(top('coconut milk'), /^Coconut, milk, canned$/);
assert.match(top('whole black peppercorns'), /^Pepper, black/);
assert.match(top('onions, sliced'), /^Onion, mature, brown/);
assert.match(top('pecorino romano, very finely grated'), /^Cheese, parmesan/);
assert.match(top('spaghetti or tonnarelli'), /^Pasta/);
const rice = n.ausnutById(n.searchAusnut('jasmine rice', 1)[0].ref);
assert.ok(rice.density && rice.density < 1, 'rice has a dry density');
console.log('regression tests passed');
assert.ok(n.searchAusnut('mozzarella', 1)[0].full, 'single-word cheese is a full match');
assert.match(top('neutral-flavoured oil'), /^Oil, not further defined/);
console.log('v4 tests passed');
