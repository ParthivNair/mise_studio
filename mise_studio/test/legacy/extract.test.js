import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRecipes, extractTextRecipe } from '../../lib/recipes/legacy/extract.js';

const url = 'https://recipes.example.test/recipes/test-bake';
const page = data => `<html><head><script type="application/ld+json">${JSON.stringify(data).replace(/<\/script/gi, '<\\/script')}</script></head></html>`;
const base = overrides => ({ '@type': 'Recipe', name: 'Test bake', recipeYield: '4 servings', recipeIngredient: ['1 cup test flour'], recipeInstructions: ['Mix the test ingredients.'], ...overrides });

test('imports JSON-LD metadata, HTML entities, explicit servings and ISO times without inventing step duration', () => {
  const result = extractRecipes({ html: page(base({ name: 'Test &amp; bake', author: [{ '@type': 'Person', name: 'Test Author' }], prepTime: 'PT10M', cookTime: 'PT1H30M', totalTime: 'P1DT5M', recipeIngredient: ['1&nbsp;cup test flour'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Bake for 10–15 minutes, then rest 30 seconds.' }] })), url });
  assert.equal(result.status, 'ready_for_review');
  const recipe = result.recipes[0];
  assert.equal(recipe.title, 'Test & bake');
  assert.equal(recipe.source.author, 'Test Author');
  assert.equal(recipe.ingredients[0].raw, '1 cup test flour');
  assert.equal(recipe.yield.servings, 4);
  assert.deepEqual(recipe.recipeTimes, { prepMinutes: 10, cookMinutes: 90, totalMinutes: 1445 });
  assert.equal(recipe.steps[0].minutes, null);
  assert.equal(recipe.steps[0].durationSource, 'unknown');
  assert.equal(recipe.steps[0].timingEvidence, '10–15 minutes; 30 seconds');
  assert.deepEqual(recipe.steps[0].timingSuggestions, [{ min: 10, max: 15, unit: 'minutes' }, { min: 0.5, max: 0.5, unit: 'minutes' }]);
});

test('resolves graph references, array types, nested sections and positioned ListItems', () => {
  const data = { '@graph': [
    base({ '@type': ['CreativeWork', 'https://schema.org/Recipe'], recipeInstructions: { '@id': '#assembly' }, author: { '@id': '#author' } }),
    { '@id': '#author', '@type': 'Person', name: 'Graph Author' },
    { '@id': '#assembly', '@type': 'HowToSection', name: 'Assembly', itemListElement: [
      { '@type': 'ListItem', position: 2, item: { '@id': '#second' } },
      { '@type': 'ListItem', position: 1, item: { '@id': '#first' } },
    ] },
    { '@id': '#first', '@type': 'HowToStep', text: 'Stir the sample batter.' },
    { '@id': '#second', '@type': 'HowToSection', name: 'Finish', itemListElement: [{ '@type': 'HowToStep', text: 'Arrange the test topping.' }] },
  ] };
  const recipe = extractRecipes({ html: page(data), url }).recipes[0];
  assert.equal(recipe.source.author, 'Graph Author');
  assert.deepEqual(recipe.steps.map(step => [step.text, step.section]), [['Stir the sample batter.', 'Assembly'], ['Arrange the test topping.', 'Assembly / Finish']]);
});

test('skips malformed JSON-LD siblings without discarding a valid recipe', () => {
  const result = extractRecipes({ html: '<script type="application/ld+json">{broken</script>' + page(base()), url });
  assert.equal(result.status, 'ready_for_review');
  assert.ok(result.warnings.some(item => item.code === 'malformed_jsonld'));
});

test('detects reference cycles and unresolved references without recursion or invented instructions', () => {
  const result = extractRecipes({ html: page({ '@graph': [base({ recipeInstructions: [{ '@id': '#loop' }, { '@id': '#missing' }] }), { '@id': '#loop', '@type': 'HowToSection', name: 'Loop', itemListElement: [{ '@id': '#loop' }] }] }), url });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.recipes[0].steps, []);
  assert.ok(result.recipes[0].warnings.some(item => item.code === 'circular_reference'));
  assert.ok(result.warnings.some(item => item.code === 'unresolved_reference'));
});

test('keeps distinct recipes separate, deduplicates exact repeated markup and gives stable IDs', () => {
  const first = base();
  const second = base({ recipeIngredient: ['2 cups alternative test flour'] });
  const result = extractRecipes({ html: page([first, first, second]), url });
  assert.equal(result.status, 'choose_recipe');
  assert.equal(result.recipes.length, 2);
  assert.notEqual(result.recipes[0].id, result.recipes[1].id);
  const repeated = extractRecipes({ html: page(first), url }).recipes[0];
  assert.equal(repeated.id, result.recipes[0].id);
  assert.equal(repeated.steps[0].id, result.recipes[0].steps[0].id);
});

test('unknown, item-count, ranged and invalid yields do not silently become servings', () => {
  for (const recipeYield of [undefined, '12', '2 loaves', 'Serves 4–6', '0 servings', { '@type': 'QuantitativeValue', value: 12, unitText: 'cookies' }]) {
    const recipe = extractRecipes({ html: page(base({ recipeYield })), url }).recipes[0];
    assert.equal(recipe.yield.servings, null, String(recipeYield));
    assert.ok(recipe.warnings.some(item => item.code === 'unknown_servings'));
  }
  const recipe = extractRecipes({ html: page(base({ recipeYield: { '@type': 'QuantitativeValue', value: 6, unitText: 'servings' } })), url }).recipes[0];
  assert.equal(recipe.yield.servings, 6);
});

test('preserves grouped structured ingredient entries and quantity values', () => {
  const recipe = extractRecipes({ html: page(base({ recipeIngredient: { '@type': 'ItemList', name: 'Test topping', itemListElement: [{ '@type': 'ListItem', position: 1, item: { '@type': 'PropertyValue', value: 2, unitText: 'cups', name: 'test crumbs' } }] } })), url }).recipes[0];
  assert.deepEqual(recipe.ingredients, [{ raw: '2 cups test crumbs', section: 'Test topping' }]);
});

test('parses explicitly formatted instruction lists and strips active HTML', () => {
  const recipe = extractRecipes({ html: page(base({ recipeInstructions: '<ol><li>Stir &amp; fold.</li><li>Cover the bowl.<script>steal()</script></li></ol>' })), url }).recipes[0];
  assert.deepEqual(recipe.steps.map(step => step.text), ['Stir & fold.', 'Cover the bowl.']);
});

test('missing fields are partial, generic articles and malformed-only pages are not recipes', () => {
  const partial = extractRecipes({ html: page({ '@type': 'Recipe', name: 'Incomplete test' }), url });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.recipes[0].steps.length, 0);
  for (const html of [page({ '@type': 'Article', name: 'Cooking guide', text: 'There are ingredients and steps.' }), '<h1>Ingredients</h1><p>example</p>', '<script type="application/ld+json">{broken</script>']) {
    assert.equal(extractRecipes({ html, url }).status, 'not_recipe');
  }
});

test('invalid times remain null, and multiple timing expressions never become an automatic schedule', () => {
  const recipe = extractRecipes({ html: page(base({ prepTime: 'soon', totalTime: 'P1M', recipeInstructions: ['Rest for 1 hour 30 minutes, then bake for 15 to 20 minutes.', 'Stir until combined.'] })), url }).recipes[0];
  assert.equal(recipe.recipeTimes.prepMinutes, null);
  assert.equal(recipe.recipeTimes.totalMinutes, null);
  assert.equal(recipe.steps[0].timingSuggestions.length, 3);
  assert.equal(recipe.steps[0].minutes, null);
  assert.equal(recipe.steps[1].minutes, null);
  assert.equal(recipe.steps[1].timingSuggestions, undefined);
});

test('microdata fallback reads recipe scope without confusing author name with recipe title', () => {
  const html = `<article itemscope itemtype="https://schema.org/Recipe">
    <span itemprop="author" itemscope itemtype="https://schema.org/Person"><span itemprop="name">Sample Author</span></span>
    <h1 itemprop="name">Microdata sample</h1><span itemprop="recipeYield">Serves 3</span>
    <meta itemprop="prepTime" content="PT5M"><ul><li itemprop="recipeIngredient">3 test ingredients</li></ul>
    <div itemprop="recipeInstructions"><ol><li>Combine the test ingredients.</li><li>Arrange on a plate.</li></ol></div>
  </article>`;
  const result = extractRecipes({ html, url });
  assert.equal(result.status, 'ready_for_review');
  const recipe = result.recipes[0];
  assert.equal(recipe.title, 'Microdata sample');
  assert.equal(recipe.source.author, 'Sample Author');
  assert.equal(recipe.source.extractor, 'schema.org-microdata');
  assert.equal(recipe.steps.length, 2);
  assert.equal(recipe.recipeTimes.prepMinutes, 5);
});

test('pasted text requires labelled sections and preserves missing data', () => {
  const result = extractTextRecipe({ text: 'Sample plate\n\nIngredients:\n- 1 test item\n- 2 sample leaves\n\nDirections:\n1. Arrange the items.\n2. Rest for 5 minutes.\nNotes:\nThis is a synthetic fixture.', sourceUrl: url });
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.recipes[0].title, 'Sample plate');
  assert.equal(result.recipes[0].ingredients.length, 2);
  assert.equal(result.recipes[0].steps.length, 2);
  assert.equal(result.recipes[0].steps[1].minutes, null);
  assert.equal(extractTextRecipe({ text: 'Make a tasty dish from these vague notes.' }).status, 'not_recipe');
  assert.equal(extractTextRecipe({ text: 'Ingredients\n1 test item', title: 'Only ingredients' }).status, 'partial');
});

test('pasted preambles do not get guessed as recipe titles and unsafe URLs are omitted', () => {
  const result = extractTextRecipe({ text: 'Long preamble\nAnother line\nIngredients\n1 test item\nMethod\nArrange it.', sourceUrl: 'javascript:alert(1)' });
  assert.equal(result.status, 'partial');
  assert.equal(result.recipes[0].title, '');
  assert.equal(result.recipes[0].source.url, undefined);
});

test('enforces input, graph depth, recipe count and output bounds explicitly', () => {
  const isLimit = error => error.code === 'extraction_limit_exceeded';
  assert.throws(() => extractRecipes({ html: 'x'.repeat(2 * 1024 * 1024 + 1) }), isLimit);
  assert.throws(() => extractTextRecipe({ text: 'x'.repeat(256 * 1024 + 1) }), isLimit);
  let deep = base();
  for (let index = 0; index < 60; index++) deep = { child: deep };
  assert.throws(() => extractRecipes({ html: page(deep), url }), isLimit);
  assert.throws(() => extractRecipes({ html: page(Array.from({ length: 13 }, (_, index) => base({ name: `Test ${index}` }))), url }), isLimit);
  assert.throws(() => extractRecipes({ html: page(base({ recipeInstructions: Array.from({ length: 301 }, () => 'Stir.') })), url }), isLimit);
  assert.throws(() => extractRecipes({ html: page(base({ recipeIngredient: ['a'.repeat(4001)] })), url }), isLimit);
  assert.throws(() => extractRecipes({ html: null }), error => error.code === 'invalid_input');
});
