import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { canonicalizeSourceUrl, createRecipeCatalog, normalizeExtractedRecipe, normalizeQuery } from './index.js';

const completeRecipe = (title = 'Mapo tofu') => ({
  title,
  source: { publisher: 'Test Kitchen', author: 'A. Cook', extractor: 'fixture' },
  yield: { raw: 'Serves 4', servings: 4 },
  ingredients: [{ raw: '1 1/2 cups tofu, cubed', section: 'Main' }, { raw: 'Salt, to taste' }],
  steps: [{ text: 'Simmer for 10 minutes.', timingEvidence: '10 minutes' }, { text: 'Serve.' }],
  recipeTimes: { prepMinutes: 5, cookMinutes: 10, totalMinutes: 15 },
  warnings: [],
});

function fixtureEnvelope(recipes = [completeRecipe()]) {
  return { status: recipes.length > 1 ? 'choose_recipe' : 'ready_for_review', recipes, warnings: [] };
}

function setup(overrides = {}) {
  let searches = 0;
  let fetches = 0;
  const searchProvider = overrides.searchProvider || { async search({ query }) { searches++; return { query, provider: 'fixture', results: [{ id: 'x', url: 'https://food.example/recipe', title: query, source: 'food.example', snippet: '' }], hasMore: false }; } };
  const fetchPage = overrides.fetchPage || (async url => { fetches++; return { ...fixtureEnvelope(), url }; });
  const catalog = createRecipeCatalog({ databasePath: ':memory:', searchProvider, fetchPage, ...overrides });
  return { catalog, counts: () => ({ searches, fetches }) };
}

test('normalization corpus preserves meaningful query distinctions and parses conservatively', () => {
  const queries = [
    ['  Mapo   Tofu ', 'mapo tofu'], ['MAPO TOFU', 'mapo tofu'], ['麻婆豆腐', '麻婆豆腐'],
    ['vegan mapo tofu', 'vegan mapo tofu'], ['mapo tofu 四川', 'mapo tofu 四川'], ['Crème brûlée', 'crème brûlée'],
    ['PAD\tTHAI', 'pad thai'], ['İskender kebap', 'i̇skender kebap'], ['กะเพรา', 'กะเพรา'], ['떡볶이', '떡볶이'],
  ];
  for (const [input, folded] of queries) assert.equal(normalizeQuery(input).folded, folded);
  assert.notEqual(normalizeQuery('mapo tofu').key, normalizeQuery('vegan mapo tofu').key);
  assert.notEqual(normalizeQuery('mapo tofu', { locale: 'en-US' }).key, normalizeQuery('mapo tofu', { locale: 'fr-FR' }).key);

  const ingredients = [
    '1 cup flour', '1 1/2 cups stock', '½ teaspoon salt', '2-3 cloves garlic, minced', '2 to 4 ounces tofu',
    'Salt, to taste', 'Pepper as needed', '1 (14-ounce) can tomatoes', '2 x 400g cans beans', 'a handful basil',
    '1/3 cup oil', '¼ cup sugar', '3 tbsp soy sauce', '100 g noodles', '1 kg potatoes',
    '2 packages tofu', '1.5 liters water', '4 cloves garlic', '3–5 pounds pork', 'maple or honey',
  ];
  const recipe = normalizeExtractedRecipe({ ...completeRecipe(), ingredients }, { sourceUrl: 'https://food.example/a' });
  assert.equal(recipe.ingredients.length, 20);
  assert.deepEqual(recipe.ingredients[1].quantity, { min: 1.5, max: 1.5 });
  assert.deepEqual(recipe.ingredients[3].quantity, { min: 2, max: 3 });
  assert.equal(recipe.ingredients[5].raw, 'Salt, to taste');
  assert.equal(recipe.ingredients[5].quantity, null);
  assert.equal(recipe.ingredients[9].name, 'a handful basil');
});

test('canonical source identity removes tracking only and retains recipe variants', () => {
  assert.equal(canonicalizeSourceUrl('HTTPS://Food.Example/a?utm_source=x&portion=vegan#card'), 'https://food.example/a?portion=vegan');
  assert.notEqual(canonicalizeSourceUrl('https://food.example/a?portion=2'), canonicalizeSourceUrl('https://food.example/a?portion=4'));
  const first = normalizeExtractedRecipe(completeRecipe('Old'), { sourceUrl: 'https://food.example/a?utm_source=x' });
  const changed = normalizeExtractedRecipe(completeRecipe('New'), { sourceUrl: 'https://food.example/a' });
  const variant = normalizeExtractedRecipe(completeRecipe('Old'), { sourceUrl: 'https://food.example/a?vegan=1' });
  assert.equal(first.recipeId, changed.recipeId);
  assert.notEqual(first.revisionId, changed.revisionId);
  assert.notEqual(first.recipeId, variant.recipeId);
});

test('twenty concurrent resolutions perform one fetch and persist one recipe', async () => {
  let fetches = 0;
  const { catalog } = setup({ fetchPage: async url => { fetches++; await new Promise(resolve => setTimeout(resolve, 15)); return { ...fixtureEnvelope(), url }; } });
  const results = await Promise.all(Array.from({ length: 20 }, () => catalog.resolve({ url: 'https://food.example/mapo?utm_campaign=x' })));
  assert.equal(fetches, 1);
  assert.equal(new Set(results.map(result => result.recipes[0].recipeId)).size, 1);
  assert.equal(results[0].recipes[0].ingredients[0].raw, '1 1/2 cups tofu, cubed');
  await catalog.close();
});

test('recipes and warm searches survive restart with zero outbound calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mise-catalog-'));
  const databasePath = join(directory, 'recipes.sqlite');
  let searches = 0; let fetches = 0;
  const provider = { async search({ query }) { searches++; return { query, provider: 'fixture', results: [{ url: 'https://food.example/mapo', title: 'Mapo' }] }; } };
  let catalog = createRecipeCatalog({ databasePath, searchProvider: provider, fetchPage: async url => { fetches++; return { ...fixtureEnvelope(), url }; } });
  const searched = await catalog.search({ query: 'mapo tofu' });
  const resolved = await catalog.resolve({ url: searched.results[0].url });
  const recipeId = resolved.recipes[0].recipeId;
  await catalog.close();
  catalog = createRecipeCatalog({ databasePath, searchProvider: provider, fetchPage: async () => { fetches++; throw new Error('offline'); } });
  assert.equal((await catalog.search({ query: 'MAPO   TOFU' })).cache.state, 'fresh');
  assert.equal((await catalog.resolve({ url: 'https://food.example/mapo' })).cache.state, 'fresh');
  assert.equal(catalog.getRecipe(recipeId).title, 'Mapo tofu');
  assert.deepEqual({ searches, fetches }, { searches: 1, fetches: 1 });
  await catalog.close();
  rmSync(directory, { recursive: true, force: true });
});

test('explicit aliases share a cached query while variants remain separate', async () => {
  const { catalog, counts } = setup({ aliases: { 'bean curd with chili': 'mapo tofu' } });
  await catalog.search({ query: 'mapo tofu' });
  assert.equal((await catalog.search({ query: 'bean curd with chili' })).cache.state, 'fresh');
  await catalog.search({ query: 'vegan mapo tofu' });
  assert.equal(counts().searches, 2);
  await catalog.close();
});

test('a stored recipe satisfies a new matching query without a provider call', async () => {
  const { catalog, counts } = setup();
  await catalog.resolve({ url: 'https://food.example/mapo' });
  const result = await catalog.search({ query: 'Mapo' });
  assert.equal(result.provider, 'catalog');
  assert.equal(result.results[0].catalog, true);
  assert.equal(counts().searches, 0);
  await catalog.close();
});

test('stale data remains available during refresh errors and misses observe cooldown', async () => {
  let clock = 1_700_000_000_000;
  let fail = false;
  const provider = { async search({ query }) { if (fail) throw new Error('provider down'); return { query, provider: 'fixture', results: [{ url: 'https://food.example/a', title: 'A' }] }; } };
  const { catalog } = setup({ searchProvider: provider, now: () => clock, searchFreshMs: 10, errorCooldownMs: 30 });
  await catalog.search({ query: 'soup' });
  clock += 11; fail = true;
  const stale = await catalog.search({ query: 'soup' });
  assert.equal(stale.cache.state, 'stale');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(catalog.search({ query: 'new query' }), /provider down/);
  await assert.rejects(catalog.search({ query: 'new query' }), error => error.code === 'SEARCH_COOLDOWN');
  await catalog.close();
});

test('partial and failed stale refreshes never replace a complete revision', async () => {
  let clock = 1_700_000_000_000;
  let mode = 'complete';
  let fetches = 0;
  const { catalog } = setup({
    now: () => clock, recipeFreshMs: 10, errorCooldownMs: 100,
    fetchPage: async url => {
      fetches++;
      if (mode === 'fail') throw new Error('source offline');
      const recipe = mode === 'partial' ? { ...completeRecipe(), ingredients: [] } : completeRecipe();
      return { ...fixtureEnvelope([recipe]), url };
    },
  });
  const initial = await catalog.resolve({ url: 'https://food.example/refresh' });
  const id = initial.recipes[0].recipeId;
  clock += 11; mode = 'partial';
  assert.equal((await catalog.resolve({ url: 'https://food.example/refresh' })).cache.state, 'stale');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.getRecipe(id).completeness, 'complete');
  mode = 'fail'; clock += 11;
  await catalog.resolve({ url: 'https://food.example/refresh' });
  await new Promise(resolve => setImmediate(resolve));
  const before = fetches;
  await catalog.resolve({ url: 'https://food.example/refresh' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, before, 'resolution error cooldown prevents another outbound fetch');
  assert.equal(catalog.getRecipe(id).completeness, 'complete');
  await catalog.close();
});

test('multi-recipe pages retain distinct node identities and persisted jobs complete', async () => {
  const recipes = [completeRecipe('Red curry'), completeRecipe('Green curry')];
  const { catalog } = setup({ fetchPage: async url => ({ ...fixtureEnvelope(recipes), url }) });
  const result = await catalog.resolve({ url: 'https://food.example/curries' });
  assert.equal(result.status, 'choose_recipe');
  assert.equal(result.recipes.length, 2);
  assert.notEqual(result.recipes[0].recipeId, result.recipes[1].recipeId);
  assert.equal(catalog.getRecipe(result.recipes[1].recipeId).title, 'Green curry');
  const job = catalog.startResolve({ url: 'https://food.example/job' });
  assert.equal(job.status, 'pending');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.getJob(job.jobId).status, 'complete');
  await catalog.close();
});

test('100 warm catalog operations stay comfortably below the 150 ms p95 target', async () => {
  const { catalog } = setup();
  await catalog.search({ query: 'mapo tofu' });
  await catalog.resolve({ url: 'https://food.example/mapo' });
  const durations = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    await catalog.search({ query: 'mapo tofu' });
    await catalog.resolve({ url: 'https://food.example/mapo' });
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[94];
  assert.ok(p95 < 150, `warm p95 was ${p95.toFixed(2)} ms`);
  await catalog.close();
});
