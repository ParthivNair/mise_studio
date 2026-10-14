import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonidTinyFishProvider, createRecipeProvider, extractMarkdownRecipe } from '../lib/recipes/providers/index.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const inspection = endpoint => response({ provider: 'tinyfish', endpoint, price: { type: 'PER_CALL', amount: 0, currency: 'USD' } });

test('search sends the inspected TinyFish queryParams contract and maps safe hits', async () => {
  const calls = [];
  const provider = createMonidTinyFishProvider({
    apiKey: 'monid_test_secret',
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, init });
      if (url.pathname === '/v1/inspect') return inspection('/search');
      return response({
        runId: 'run-1', status: 'COMPLETED', providerResponse: { httpStatus: 200 },
        output: { results: [{ title: 'Mapo Tofu', url: 'https://example.com/mapo', snippet: 'A recipe' }] },
      });
    },
  });
  const result = await provider.search({ query: ' mapo   tofu ', kind: 'recipe', count: 3 });
  assert.equal(result.provider, 'tinyfish');
  assert.equal(result.results[0].source, 'example.com');
  const request = JSON.parse(calls[1].init.body);
  assert.deepEqual(request, {
    provider: 'tinyfish', endpoint: '/search',
    input: { queryParams: { query: 'mapo tofu recipe', domain_type: 'web' } },
  });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer monid_test_secret');
});

test('fetchPage uses one URL and preserves rendered Markdown', async () => {
  let request;
  const provider = createMonidTinyFishProvider({
    apiKey: 'monid_test_secret',
    fetchImpl: async (_url, init) => {
      if (_url.pathname === '/v1/inspect') return inspection('/fetch');
      request = JSON.parse(init.body);
      return response({
        runId: 'run-2', status: 'COMPLETED', providerResponse: { httpStatus: 200 },
        output: [{ url: 'https://example.com/recipe', title: 'Recipe', text: '# Recipe\n\n## Ingredients\n- 14 oz firm tofu\n\n## Instructions\n1. Drain the tofu.' }],
      });
    },
  });
  const page = await provider.fetchPage('https://example.com/recipe');
  assert.equal(page.status, 'ready_for_review');
  assert.equal(page.recipes[0].ingredients[0].raw, '14 oz firm tofu');
  assert.deepEqual(request, {
    provider: 'tinyfish', endpoint: '/fetch',
    input: { body: { urls: ['https://example.com/recipe'], format: 'markdown' } },
  });
});

test('polls an asynchronous run until completion', async () => {
  let call = 0;
  const provider = createMonidTinyFishProvider({
    apiKey: 'monid_test_secret', pollIntervalMs: 1,
    fetchImpl: async (url) => {
      call += 1;
      if (url.pathname === '/v1/inspect') return inspection('/search');
      if (url.pathname === '/v1/run') return response({ runId: '01ASYNC', status: 'RUNNING' }, 202);
      return response({ runId: '01ASYNC', status: 'COMPLETED', providerResponse: { httpStatus: 200 }, output: { results: [] } });
    },
  });
  const result = await provider.search({ query: 'ramen' });
  assert.equal(call, 3);
  assert.deepEqual(result.results, []);
});

test('maps Monid auth and TinyFish rate-limit failures to bounded API errors', async (t) => {
  await t.test('Monid auth', async () => {
    const provider = createMonidTinyFishProvider({ apiKey: 'bad', fetchImpl: async () => response({ error: 'unauthorized' }, 401) });
    await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_AUTH_FAILED', status: 503 });
  });
  await t.test('provider rate limit', async () => {
    const provider = createMonidTinyFishProvider({
      apiKey: 'key',
      fetchImpl: async (url) => url.pathname === '/v1/inspect' ? inspection('/search') : response({ status: 'COMPLETED', providerResponse: { httpStatus: 429 }, output: null }),
    });
    await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_RATE_LIMITED', status: 503 });
  });
});

test('rejects malformed output, terminal failures, unsafe URLs, and timeouts', async (t) => {
  await t.test('malformed', async () => {
    const provider = createMonidTinyFishProvider({
      apiKey: 'key', fetchImpl: async (url) => url.pathname === '/v1/inspect' ? inspection('/search') : response({ status: 'COMPLETED', providerResponse: { httpStatus: 200 }, output: { unexpected: true } }),
    });
    await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_BAD_RESPONSE' });
  });
  await t.test('terminal', async () => {
    const provider = createMonidTinyFishProvider({ apiKey: 'key', fetchImpl: async (url) => url.pathname === '/v1/inspect' ? inspection('/search') : response({ runId: 'r', status: 'FAILED' }) });
    await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_FAILED' });
  });
  await t.test('unsafe result is dropped', async () => {
    const provider = createMonidTinyFishProvider({
      apiKey: 'key', fetchImpl: async (url) => url.pathname === '/v1/inspect' ? inspection('/search') : response({
        status: 'COMPLETED', providerResponse: { httpStatus: 200 },
        output: { results: [{ title: 'Internal', url: 'http://127.0.0.1/secret', snippet: '' }] },
      }),
    });
    assert.deepEqual((await provider.search({ query: 'ramen' })).results, []);
  });
  await t.test('timeout', async () => {
    const provider = createMonidTinyFishProvider({
      apiKey: 'key', timeoutMs: 5, pollIntervalMs: 1,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    });
    await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_TIMEOUT', status: 504 });
  });
});

test('refuses to run when current inspect pricing is not zero', async () => {
  let calls = 0;
  const provider = createMonidTinyFishProvider({
    apiKey: 'key',
    fetchImpl: async () => {
      calls += 1;
      return response({ provider: 'tinyfish', endpoint: '/search', price: { type: 'PER_CALL', amount: 0.01, currency: 'USD' } });
    },
  });
  await assert.rejects(provider.search({ query: 'ramen' }), { code: 'PROVIDER_NOT_FREE' });
  assert.equal(calls, 1);
});

test('Markdown adapter extracts labelled amounts and ordered steps, excluding unrelated sections', () => {
  const result = extractMarkdownRecipe({
    sourceUrl: 'https://example.com/mapo',
    markdown: `# Mapo Tofu

Introductory story that is not a recipe field.

## Ingredients
- **14 oz** soft tofu, cubed
- [2 tbsp doubanjiang](https://example.com/bean-paste)

## Instructions
1. Drain the tofu.
2. Bloom the chile flakes.

## Nutrition
- Calories: 400

## Comments
1. Great recipe!
`,
  });
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.recipes[0].title, 'Mapo Tofu');
  assert.deepEqual(result.recipes[0].ingredients.map(item => item.raw), ['14 oz soft tofu, cubed', '2 tbsp doubanjiang']);
  assert.deepEqual(result.recipes[0].steps.map(item => item.text), ['Drain the tofu.', 'Bloom the chile flakes.']);
});

test('factory retains the working fallback when Monid is not configured', async () => {
  const fallback = {
    search: async () => ({ provider: 'fixture', results: [] }),
    suggest: async () => ({ provider: 'fixture', suggestions: [] }),
  };
  const provider = createRecipeProvider({ fallbackProvider: fallback, safeFetcher: async () => ({ html: '<p>x</p>' }) });
  assert.equal((await provider.search()).provider, 'fixture');
  assert.equal(provider.capabilities.renderedFetch, false);
  assert.equal((await provider.fetchPage('https://example.com')).html, '<p>x</p>');
});

test('legacy suggest capability follows the Brave key or an explicit fallback', () => {
  const without = createRecipeProvider({ monidApiKey: '', braveApiKey: '' });
  assert.equal(without.capabilities.provider, 'legacy');
  assert.equal(without.capabilities.suggest, false);
  const brave = createRecipeProvider({ monidApiKey: '', braveApiKey: 'k' });
  assert.equal(brave.capabilities.suggest, true);
  const fallback = createRecipeProvider({
    monidApiKey: '',
    fallbackProvider: { suggest: async () => ({ suggestions: [] }) },
  });
  assert.equal(fallback.capabilities.provider, 'legacy');
  assert.equal(fallback.capabilities.suggest, true);
});

test('Monid does not advertise suggest', () => {
  const provider = createMonidTinyFishProvider({ apiKey: 'k', fetchImpl: async () => response({}) });
  assert.equal(provider.capabilities.suggest, false);
});
