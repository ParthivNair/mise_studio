import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import ipaddr from 'ipaddr.js';
import { ApiError } from './errors.js';
import { isPublicAddress } from './safe-fetch.js';

const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/';
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DDG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const badResponse = () => new ApiError(502, 'PROVIDER_BAD_RESPONSE', 'The search provider returned an invalid response.');
const hasBraveKey = (apiKey) => typeof apiKey === 'string' && Boolean(apiKey.trim());

function validateInput(query, count, maxCharacters, maxWords) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ApiError(400, 'INVALID_QUERY', 'A non-empty query is required.');
  }
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (normalized.length > maxCharacters || normalized.split(' ').length > maxWords) {
    throw new ApiError(400, 'INVALID_QUERY', `Query must contain at most ${maxCharacters} characters and ${maxWords} words.`);
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new ApiError(400, 'INVALID_COUNT', 'Count must be an integer between 1 and 20.');
  }
  return normalized;
}

// Provider strings are plain text, not trusted HTML. Consumers must render them as text.
function plainText(value) {
  const $ = load(value, null, false);
  $('script, style, noscript, template').remove();
  $('br').replaceWith(' ');
  $('p, div, li').append(' ');
  return $.root().text().replace(/\s+/g, ' ').trim();
}

function safeResultUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (ipaddr.isValid(hostname)) {
      if (!isPublicAddress(hostname)) return null;
    } else if (/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(hostname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

function unwrapDuckDuckGoHref(value) {
  if (typeof value !== 'string' || !value) return null;
  const absolute = value.startsWith('//') ? `https:${value}` : value;
  let current = safeResultUrl(absolute);
  if (!current) return null;
  if (hostOf(current) === 'duckduckgo.com' && current.pathname === '/l/') {
    const target = current.searchParams.get('uddg');
    current = target ? safeResultUrl(target) : null;
  }
  if (!current) return null;
  const host = hostOf(current);
  if (host === 'duckduckgo.com' || host === 'bing.com') return null;
  return current;
}

function mapSearchHit(url, title, snippet) {
  const cleanedTitle = plainText(title);
  if (!cleanedTitle) return null;
  return {
    id: createHash('sha256').update(url.href).digest('hex').slice(0, 24),
    url: url.href,
    title: cleanedTitle,
    source: hostOf(url),
    snippet: plainText(snippet ?? ''),
  };
}

function parseDuckDuckGoResults(html, count) {
  const $ = load(html);
  if (!$('form[action="/html/"]').length && !$('.web-result, .result__a').length) throw badResponse();
  const results = [];
  const seen = new Set();
  $('.web-result').each((_, element) => {
    if (results.length >= count) return;
    if ($(element).hasClass('result--ad')) return;
    const link = $(element).find('a.result__a').first();
    const url = unwrapDuckDuckGoHref(link.attr('href') || '');
    if (!url || seen.has(url.href)) return;
    const hit = mapSearchHit(
      url,
      link.html() || link.text(),
      $(element).find('.result__snippet').first().html() || '',
    );
    if (!hit) return;
    seen.add(url.href);
    results.push(hit);
  });
  return results;
}

async function readBytes(response, signal, allowType) {
  const declaredLength = response.headers.get('content-length');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if ((declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES)
    || (contentType && !allowType(contentType))
    || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw badResponse();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw badResponse();
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function readJson(response, signal) {
  const bytes = await readBytes(response, signal, (type) => type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type));
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw badResponse();
  }
}

async function readHtml(response, signal) {
  const bytes = await readBytes(response, signal, (type) => type === 'text/html' || type === 'application/xhtml+xml');
  return new TextDecoder('utf-8').decode(bytes);
}

function isBlockedSearchPage(html) {
  return /bots use DuckDuckGo|anomaly|Please complete the following challenge/i.test(html)
    || (!html.includes('web-result') && !html.includes('result__a') && !html.includes('form action="/html/"'));
}

function mergeHits(groups, count) {
  const seen = new Set();
  const results = [];
  for (let index = 0; results.length < count; index += 1) {
    let added = false;
    for (const group of groups) {
      const item = group[index];
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
      added = true;
      if (results.length >= count) break;
    }
    if (!added) break;
  }
  return results;
}

function fallbackQueries(query) {
  const attempts = [query];
  const words = query.split(' ').filter((word) => word.length >= 3 && !/^recipes?$/i.test(word));
  const last = words.at(-1);
  if (last && last !== query) attempts.push(last);
  return attempts;
}

function throwHttpError(response) {
  void response.body?.cancel().catch(() => {});
  if (response.status === 429) {
    throw new ApiError(503, 'PROVIDER_RATE_LIMITED', 'The search provider quota or rate limit was reached.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(503, 'PROVIDER_AUTH_FAILED', 'The search provider credentials or subscription need attention.');
  }
  throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'The search provider is unavailable.');
}

/** Server-only adapter. Never put a Brave subscription token in a browser bundle. */
export function createSearchProvider({ apiKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be a positive timer duration.');
  }
  const braveEnabled = hasBraveKey(apiKey);

  async function withTimeout(signal, work) {
    signal?.throwIfAborted();
    const timeout = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(new ApiError(504, 'PROVIDER_TIMEOUT', 'The search provider timed out.')), timeoutMs);
    let onAbort;
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work(combined), cancelled]);
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'The search provider is unavailable.');
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(url, signal, { allowStatuses = [] } = {}) {
    return withTimeout(signal, async (combined) => {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: combined,
      });
      if (combined.aborted) {
        void response.body?.cancel().catch(() => {});
        combined.throwIfAborted();
      }
      if (allowStatuses.includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, payload: null };
      }
      if (!response.ok) throwHttpError(response);
      return { status: response.status, payload: await readJson(response, combined) };
    });
  }

  async function requestBrave(endpoint, parameters, signal) {
    const url = new URL(endpoint, BRAVE_BASE_URL);
    url.search = new URLSearchParams(parameters).toString();
    return withTimeout(signal, async (combined) => {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: combined,
      });
      if (combined.aborted) {
        void response.body?.cancel().catch(() => {});
        combined.throwIfAborted();
      }
      if (!response.ok) throwHttpError(response);
      return readJson(response, combined);
    });
  }

  async function searchDuckDuckGo(providerQuery, count, signal) {
    return withTimeout(signal, async (combined) => {
      const url = new URL(DDG_SEARCH_URL);
      url.searchParams.set('q', providerQuery);
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'text/html', 'User-Agent': DDG_USER_AGENT },
        signal: combined,
      });
      if (combined.aborted) {
        void response.body?.cancel().catch(() => {});
        combined.throwIfAborted();
      }
      if (response.status === 202) {
        void response.body?.cancel().catch(() => {});
        return [];
      }
      if (!response.ok) throwHttpError(response);
      const html = await readHtml(response, combined);
      if (isBlockedSearchPage(html)) return [];
      return parseDuckDuckGoResults(html, count);
    });
  }

  async function searchForkify(query, count, signal) {
    const hits = [];
    for (const attempt of fallbackQueries(query)) {
      const url = new URL('https://forkify-api.herokuapp.com/api/search');
      url.searchParams.set('q', attempt);
      const { status, payload } = await requestJson(url, signal, { allowStatuses: [400] });
      if (status === 400) continue;
      const recipes = Array.isArray(payload?.recipes) ? payload.recipes : [];
      const seen = new Set();
      for (const item of recipes) {
        if (!isRecord(item) || typeof item.title !== 'string' || typeof item.source_url !== 'string') continue;
        const parsed = safeResultUrl(item.source_url);
        if (!parsed || seen.has(parsed.href)) continue;
        const hit = mapSearchHit(parsed, item.title, item.publisher || '');
        if (!hit) continue;
        seen.add(parsed.href);
        hits.push(hit);
        if (hits.length >= count) return hits;
      }
      if (hits.length) return hits;
    }
    return hits;
  }

  async function searchMealDb(query, count, signal) {
    const hits = [];
    for (const attempt of fallbackQueries(query)) {
      const url = new URL('https://www.themealdb.com/api/json/v1/1/search.php');
      url.searchParams.set('s', attempt);
      const { payload } = await requestJson(url, signal);
      const meals = Array.isArray(payload?.meals) ? payload.meals : [];
      const seen = new Set();
      for (const item of meals) {
        if (!isRecord(item) || typeof item.strMeal !== 'string') continue;
        const parsed = safeResultUrl(item.strSource || '');
        if (!parsed || seen.has(parsed.href)) continue;
        const hit = mapSearchHit(
          parsed,
          item.strMeal,
          [item.strArea, item.strCategory].filter(Boolean).join(' · '),
        );
        if (!hit) continue;
        seen.add(parsed.href);
        hits.push(hit);
        if (hits.length >= count) return hits;
      }
      if (hits.length) return hits;
    }
    return hits;
  }

  async function searchOpenWeb(normalized, webQuery, count, signal) {
    const settled = await Promise.allSettled([
      searchDuckDuckGo(webQuery, count, signal),
      searchForkify(normalized, count, signal),
      searchMealDb(normalized, count, signal),
    ]);
    if (signal?.aborted) signal.throwIfAborted();
    const groups = [];
    const errors = [];
    for (const entry of settled) {
      if (entry.status === 'fulfilled') groups.push(entry.value);
      else if (entry.reason?.name !== 'AbortError') errors.push(entry.reason);
    }
    const results = mergeHits(groups, count);
    if (results.length || errors.length < settled.length) {
      return { query: normalized, provider: 'open', results, hasMore: false };
    }
    throw errors[0] || new ApiError(502, 'PROVIDER_UNAVAILABLE', 'The search provider is unavailable.');
  }

  return {
    async search({ query, count = 6, kind = 'web', signal } = {}) {
      if (!['web', 'recipe'].includes(kind)) throw new ApiError(400, 'INVALID_KIND', 'Kind must be web or recipe.');
      const probe = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
      const suffix = kind === 'recipe' && probe && !/\brecipes?\b/i.test(probe) ? ' recipe' : '';
      const normalized = validateInput(query, count, 600 - suffix.length, suffix ? 74 : 75);
      const providerQuery = suffix ? `${normalized}${suffix}` : normalized;
      if (braveEnabled) {
        const payload = await requestBrave('web/search', {
          q: providerQuery, count: String(count), result_filter: 'web', text_decorations: 'false',
        }, signal);
        if (!isRecord(payload) || (payload.type !== undefined && payload.type !== 'search') || payload.error) throw badResponse();
        // Brave can omit the web section for a successful search with no web matches.
        if (payload.web == null && payload.type !== 'search') throw badResponse();
        if (payload.web != null && (!isRecord(payload.web) || !Array.isArray(payload.web.results))) throw badResponse();
        if (payload.query?.more_results_available != null && typeof payload.query.more_results_available !== 'boolean') throw badResponse();
        const results = [];
        const seen = new Set();
        for (const item of payload.web?.results ?? []) {
          if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string'
            || (item.description != null && typeof item.description !== 'string')) throw badResponse();
          const url = safeResultUrl(item.url);
          if (!url || seen.has(url.href)) continue;
          const hit = mapSearchHit(url, item.title, item.description ?? '');
          if (!hit) continue;
          seen.add(url.href);
          results.push(hit);
        }
        return { query: normalized, provider: 'brave', results: results.slice(0, count), hasMore: payload.query?.more_results_available === true };
      }
      return searchOpenWeb(normalized, providerQuery, count, signal);
    },

    async suggest({ query, count = 6, signal } = {}) {
      const normalized = validateInput(query, count, 400, 50);
      if (!braveEnabled) {
        return { query: normalized, provider: 'open', suggestions: [] };
      }
      const payload = await requestBrave('suggest/search', { q: normalized, count: String(count) }, signal);
      if (!isRecord(payload) || (payload.type !== undefined && payload.type !== 'suggest') || payload.error
        || !Array.isArray(payload.results)) throw badResponse();
      const suggestions = [];
      const seen = new Set();
      for (const item of payload.results) {
        if (!isRecord(item) || typeof item.query !== 'string') throw badResponse();
        const text = plainText(item.query);
        if (!text || seen.has(text.toLocaleLowerCase('en-US'))) continue;
        seen.add(text.toLocaleLowerCase('en-US'));
        suggestions.push(text);
      }
      return { query: normalized, provider: 'brave', suggestions: suggestions.slice(0, count) };
    },
  };
}
