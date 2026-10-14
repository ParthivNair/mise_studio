import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchProvider } from '../../lib/recipes/legacy/search.js';

const code = expected => err => err.code === expected && Number.isInteger(err.status);
const jsonResponse = (payload, { status = 200, headers = { 'content-type': 'application/json' } } = {}) =>
  new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers });

function provider(handler) {
  const calls = [];
  const search = createSearchProvider({
    apiKey: 'brave-test-key',
    timeoutMs: 50,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return handler(new URL(url), options, calls.at(-1));
    },
  });
  return { search, calls };
}

test('search maps Brave web results, strips markup, and ignores unsafe URLs', async () => {
  const { search, calls } = provider(() => jsonResponse({
    type: 'search',
    query: { more_results_available: true },
    web: { results: [
      { title: 'Tomato <b>soup</b>', url: 'https://recipes.example.com/soup', description: 'A <script>x</script>warm bowl.' },
      { title: 'Private', url: 'http://127.0.0.1/soup', description: 'nope' },
      { title: 'Repeat', url: 'https://recipes.example.com/soup', description: 'dup' },
      { title: 'FTP', url: 'ftp://files.example.com/soup', description: 'nope' },
      { title: 'Creds', url: 'https://user:pass@example.com/soup', description: 'nope' },
    ] },
  }));
  const result = await search.search({ query: '  tomato   soup  ', count: 6, kind: 'web' });
  assert.equal(calls[0].url.pathname, '/res/v1/web/search');
  assert.equal(calls[0].url.searchParams.get('q'), 'tomato soup');
  assert.equal(calls[0].options.headers['X-Subscription-Token'], 'brave-test-key');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.provider, 'brave');
  assert.equal(result.query, 'tomato soup');
  assert.equal(result.hasMore, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Tomato soup');
  assert.equal(result.results[0].snippet, 'A warm bowl.');
  assert.equal(result.results[0].source, 'recipes.example.com');
  assert.equal(result.results[0].url, 'https://recipes.example.com/soup');
  assert.match(result.results[0].id, /^[a-f0-9]{24}$/);
});

test('recipe kind appends recipe when missing and leaves it intact when present', async () => {
  const queries = [];
  const { search } = provider(url => {
    queries.push(url.searchParams.get('q'));
    return jsonResponse({ type: 'search', web: { results: [] } });
  });
  await search.search({ query: 'weeknight lentils', kind: 'recipe' });
  await search.search({ query: 'lentil recipes', kind: 'recipe' });
  assert.deepEqual(queries, ['weeknight lentils recipe', 'lentil recipes']);
});

test('search rejects invalid input before contacting the provider', async () => {
  const { search, calls } = provider(() => jsonResponse({ type: 'search', web: { results: [] } }));
  await assert.rejects(search.search({ query: '' }), code('INVALID_QUERY'));
  await assert.rejects(search.search({ query: 'ok', count: 0 }), code('INVALID_COUNT'));
  await assert.rejects(search.search({ query: 'ok', kind: 'images' }), code('INVALID_KIND'));
  await assert.rejects(search.search({ query: 'x'.repeat(601) }), code('INVALID_QUERY'));
  await assert.rejects(search.search({ query: 'word '.repeat(76).trim() }), code('INVALID_QUERY'));
  assert.equal(calls.length, 0);
});

test('recipe kind reserves space for the appended keyword', async () => {
  const { search, calls } = provider(() => jsonResponse({ type: 'search', web: { results: [] } }));
  await assert.rejects(search.search({ query: 'a'.repeat(594), kind: 'recipe' }), code('INVALID_QUERY'));
  assert.equal(calls.length, 0);
  const { search: ok } = provider(() => jsonResponse({ type: 'search', web: { results: [] } }));
  await ok.search({ query: 'a'.repeat(593), kind: 'recipe' });
});

test('suggest returns unique plain-text queries', async () => {
  const { search, calls } = provider(() => jsonResponse({
    type: 'suggest',
    results: [
      { query: '  tomato <i>soup</i> ' },
      { query: 'Tomato soup' },
      { query: 'tomato bisque' },
      { query: '' },
    ],
  }));
  const result = await search.suggest({ query: 'tom', count: 6 });
  assert.equal(calls[0].url.pathname, '/res/v1/suggest/search');
  assert.deepEqual(result.suggestions, ['tomato soup', 'tomato bisque']);
});

test('without an API key, search uses open recipe indexes and DuckDuckGo HTML, skipping ads', async () => {
  const calls = [];
  const html = `<!doctype html><html><body>
    <form action="/html/" method="post"></form>
    <div class="result result--ad"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_provider%3Dx">Sponsored soup</a></div>
    <div class="result web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frecipes.example.com%2Fsoup">Tomato <b>soup</b></a><a class="result__snippet">A <script>x</script>warm bowl.</a></div>
    <div class="result web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%2Fsoup">Private</a></div>
  </body></html>`;
  const search = createSearchProvider({
    apiKey: '',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      const host = new URL(url).hostname;
      if (host === 'html.duckduckgo.com') {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
      }
      if (host === 'forkify-api.herokuapp.com') {
        return jsonResponse({ error: 'no' }, { status: 400 });
      }
      if (host === 'www.themealdb.com') {
        return jsonResponse({ meals: null });
      }
      throw new Error('unexpected ' + url);
    },
  });
  const result = await search.search({ query: 'tomato soup', count: 6, kind: 'recipe' });
  const ddg = calls.find((call) => call.url.hostname === 'html.duckduckgo.com');
  assert.ok(ddg);
  assert.equal(ddg.url.searchParams.get('q'), 'tomato soup recipe');
  assert.equal(ddg.options.headers['User-Agent']?.includes('Mozilla'), true);
  assert.ok(calls.some((call) => call.url.hostname === 'forkify-api.herokuapp.com'));
  assert.ok(calls.some((call) => call.url.hostname === 'www.themealdb.com'));
  assert.equal(result.provider, 'open');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Tomato soup');
  assert.equal(result.results[0].url, 'https://recipes.example.com/soup');
  assert.equal(result.results[0].snippet, 'A warm bowl.');
  const suggestions = await search.suggest({ query: 'tom' });
  assert.equal(suggestions.provider, 'open');
  assert.deepEqual(suggestions.suggestions, []);
});

test('open search skips DuckDuckGo challenge pages and uses recipe indexes', async () => {
  const search = createSearchProvider({
    apiKey: '',
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      if (host === 'html.duckduckgo.com') {
        return new Response('<html><title>DuckDuckGo</title><body>anomaly-modal</body></html>', {
          status: 202,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (host === 'forkify-api.herokuapp.com') {
        return jsonResponse({ error: 'no' }, { status: 400 });
      }
      if (host === 'www.themealdb.com') {
        return jsonResponse({
          meals: [{
            strMeal: 'Pad Thai',
            strSource: 'https://www.bbcgoodfood.com/recipes/easy-pad-thai',
            strArea: 'Thai',
            strCategory: 'Seafood',
          }],
        });
      }
      throw new Error('unexpected ' + url);
    },
  });
  const result = await search.search({ query: 'pad thai', kind: 'recipe' });
  assert.equal(result.provider, 'open');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Pad Thai');
  assert.equal(result.results[0].url, 'https://www.bbcgoodfood.com/recipes/easy-pad-thai');
  assert.equal(result.results[0].source, 'bbcgoodfood.com');
});

test('open search maps Forkify publisher URLs and skips unsafe ones', async () => {
  const search = createSearchProvider({
    apiKey: '',
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      if (host === 'html.duckduckgo.com') {
        return new Response('<html><title>DuckDuckGo</title><body>anomaly</body></html>', {
          status: 202,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (host === 'www.themealdb.com') {
        return jsonResponse({ meals: null });
      }
      if (host === 'forkify-api.herokuapp.com') {
        return jsonResponse({
          recipes: [
            { title: 'Pizza <b>pie</b>', source_url: 'https://recipes.example.com/pizza', publisher: 'All Recipes' },
            { title: 'Private', source_url: 'http://127.0.0.1/pizza', publisher: 'local' },
            { title: 'Repeat', source_url: 'https://recipes.example.com/pizza', publisher: 'dup' },
          ],
        });
      }
      throw new Error('unexpected ' + url);
    },
  });
  const result = await search.search({ query: 'pizza', kind: 'recipe' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Pizza pie');
  assert.equal(result.results[0].url, 'https://recipes.example.com/pizza');
  assert.equal(result.results[0].snippet, 'All Recipes');
});

test('open search returns empty results when every source is blocked or unmatched', async () => {
  const search = createSearchProvider({
    apiKey: '',
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      if (host === 'html.duckduckgo.com') {
        return new Response('<html><title>DuckDuckGo</title><body>anomaly</body></html>', {
          status: 202,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (host === 'forkify-api.herokuapp.com') return jsonResponse({ error: 'no' }, { status: 400 });
      if (host === 'www.themealdb.com') return jsonResponse({ meals: null });
      throw new Error('unexpected ' + url);
    },
  });
  const result = await search.search({ query: 'xyzzy', kind: 'recipe' });
  assert.equal(result.provider, 'open');
  assert.deepEqual(result.results, []);
});

test('open search fails only when every source is unavailable', async () => {
  const search = createSearchProvider({
    apiKey: '',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await assert.rejects(search.search({ query: 'soup' }), code('PROVIDER_UNAVAILABLE'));
});

test('provider HTTP failures stay distinguishable', async () => {
  for (const [status, expected] of [[429, 'PROVIDER_RATE_LIMITED'], [401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [500, 'PROVIDER_UNAVAILABLE']]) {
    const { search } = provider(() => jsonResponse({ error: 'no' }, { status }));
    await assert.rejects(search.search({ query: 'soup' }), code(expected));
  }
});

test('invalid payloads, content types and oversized bodies are rejected', async () => {
  const cases = [
    { payload: { type: 'search', error: { message: 'no' } }, method: 'search' },
    { payload: { type: 'search', web: { results: 'nope' } }, method: 'search' },
    { payload: { type: 'search', web: { results: [{ title: 1, url: 'https://example.com/' }] } }, method: 'search' },
    { payload: { type: 'suggest', results: [{ query: 1 }] }, method: 'suggest' },
    { payload: '<html></html>', method: 'search', headers: { 'content-type': 'text/html' } },
    { payload: '{"web":{"results":[]}}', method: 'search', headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) } },
    { payload: '{', method: 'search' },
  ];
  for (const item of cases) {
    const { search } = provider(() => jsonResponse(item.payload, { headers: item.headers }));
    await assert.rejects(search[item.method]({ query: 'soup' }), code('PROVIDER_BAD_RESPONSE'));
  }
});

test('malformed JSON-LD-like search payloads and missing web matches remain valid empty searches', async () => {
  const { search } = provider(() => jsonResponse({ type: 'search', web: null }));
  assert.deepEqual((await search.search({ query: 'soup' })).results, []);
});

test('timeouts and caller aborts cancel in-flight provider calls', async () => {
  const { search } = provider(() => new Promise(() => {}));
  await assert.rejects(search.search({ query: 'soup' }), code('PROVIDER_TIMEOUT'));
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const pending = provider(() => new Promise(() => {})).search.search({ query: 'soup', signal: controller.signal });
  await assert.rejects(pending, error => error === controller.signal.reason || error.message === 'stopped');
});
