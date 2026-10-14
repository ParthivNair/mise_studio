import { createHash } from 'node:crypto';
import { ApiError } from '../legacy/errors.js';
import { validatePublicUrl } from '../legacy/safe-fetch.js';
import { extractMarkdownRecipe } from './markdown.js';

const DEFAULT_BASE_URL = 'https://api.monid.ai';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT']);
const WAITING = new Set(['READY', 'RUNNING', 'STOPPING']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const providerError = (status, code, message, details) => new ApiError(status, code, message, details);

function validateOptions({ apiKey, fetchImpl, timeoutMs, pollIntervalMs, maxResponseBytes }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('A Monid API key is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 165_000) throw new TypeError('timeoutMs must be between 1 and 165000.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > timeoutMs) throw new TypeError('pollIntervalMs must be a positive duration no larger than timeoutMs.');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError('maxResponseBytes must be a positive safe integer.');
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function validateQuery(query, count) {
  const normalized = cleanText(query, 601);
  if (!normalized) throw providerError(400, 'INVALID_QUERY', 'A non-empty query is required.');
  if (normalized.length > 600 || normalized.split(' ').length > 75) throw providerError(400, 'INVALID_QUERY', 'Query must contain at most 600 characters and 75 words.');
  if (!Number.isInteger(count) || count < 1 || count > 20) throw providerError(400, 'INVALID_COUNT', 'Count must be an integer between 1 and 20.');
  return normalized;
}

function mapHttpFailure(status, details) {
  if (status === 401 || status === 403) return providerError(503, 'PROVIDER_AUTH_FAILED', 'Monid credentials need attention.', details);
  if (status === 429) return providerError(503, 'PROVIDER_RATE_LIMITED', 'Monid or TinyFish is rate limiting requests.', details);
  if (status === 400 || status === 404 || status === 422) return providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider rejected the verified request contract.', details);
  return providerError(502, 'PROVIDER_UNAVAILABLE', 'The recipe provider is unavailable.', details);
}

async function readJson(response, signal, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider response exceeded its size limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider response exceeded its size limit.');
    try { return JSON.parse(text); } catch { throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider returned invalid JSON.'); }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider response exceeded its size limit.');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error;
    throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'The provider returned invalid JSON.');
  } finally {
    reader.releaseLock();
  }
}

function outputItems(output) {
  if (isRecord(output) && Array.isArray(output.results)) return output.results;
  throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'TinyFish returned an invalid search result.');
}

function mapSearchOutput(output, count) {
  const results = [];
  const seen = new Set();
  for (const item of outputItems(output)) {
    if (!isRecord(item) || typeof item.url !== 'string' || typeof item.title !== 'string') {
      throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'TinyFish returned an invalid search result.');
    }
    let url;
    try { url = validatePublicUrl(item.url); } catch { continue; }
    if (seen.has(url.href)) continue;
    const title = cleanText(item.title, 500);
    if (!title) continue;
    seen.add(url.href);
    results.push({
      id: createHash('sha256').update(url.href).digest('hex').slice(0, 24),
      url: url.href,
      title,
      source: url.hostname.replace(/^www\./i, '').toLowerCase(),
      snippet: cleanText(item.snippet ?? item.description ?? '', 2_000),
    });
    if (results.length === count) break;
  }
  return results;
}

function mapFetchOutput(output, requestedUrl) {
  const documents = Array.isArray(output) ? output : null;
  if (!documents || !documents.length || !isRecord(documents[0])) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'TinyFish returned an invalid fetch result.');
  const document = documents[0];
  const text = document.text;
  if (typeof text !== 'string' || !text.trim()) throw providerError(422, 'EMPTY_RESPONSE', 'TinyFish returned no readable page content.');
  const finalValue = document.final_url ?? document.url ?? requestedUrl;
  let finalUrl;
  try { finalUrl = validatePublicUrl(finalValue).href; } catch { throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'TinyFish returned an invalid final URL.'); }
  return extractMarkdownRecipe({ markdown: text, sourceUrl: finalUrl, title: cleanText(document.title ?? '', 500) });
}

export function createMonidTinyFishProvider({
  apiKey,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 20_000,
  fetchTimeoutMs = 165_000,
  pollIntervalMs = 250,
  maxResponseBytes = 5_000_000,
} = {}) {
  validateOptions({ apiKey, fetchImpl, timeoutMs: Math.max(timeoutMs, fetchTimeoutMs), pollIntervalMs, maxResponseBytes });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 165_000 || !Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 1 || fetchTimeoutMs > 165_000) {
    throw new TypeError('Provider timeouts must be between 1 and 165000.');
  }
  let apiBase;
  try { apiBase = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an absolute URL.'); }
  if (apiBase.protocol !== 'https:' && apiBase.hostname !== 'localhost') throw new TypeError('baseUrl must use HTTPS.');
  const inspected = new Map();

  async function delay(ms, signal) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function request(path, init, signal) {
    let response;
    try { response = await fetchImpl(new URL(path, apiBase), { ...init, redirect: 'error', signal }); }
    catch { signal.throwIfAborted(); throw providerError(502, 'PROVIDER_UNAVAILABLE', 'The recipe provider could not be reached.'); }
    const payload = await readJson(response, signal, maxResponseBytes);
    if (!response.ok) throw mapHttpFailure(response.status, { upstreamStatus: response.status });
    if (!isRecord(payload)) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'Monid returned an invalid run response.');
    return payload;
  }

  async function verifyFreeEndpoint(endpoint, signal) {
    if (inspected.has(endpoint)) return inspected.get(endpoint);
    const check = (async () => {
      const details = await request('/v1/inspect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ provider: 'tinyfish', endpoint }),
      }, signal);
      if (details.provider !== 'tinyfish' || details.endpoint !== endpoint || !isRecord(details.price)
        || details.price.amount !== 0 || ![undefined, null, 0].includes(details.price.flatFee)) {
        throw providerError(503, 'PROVIDER_NOT_FREE', 'TinyFish activation requires a current zero-price inspection.', { endpoint });
      }
      return true;
    })();
    inspected.set(endpoint, check);
    try { return await check; } catch (error) { inspected.delete(endpoint); throw error; }
  }

  function evaluate(run) {
    if (WAITING.has(run.status)) return null;
    if (!TERMINAL.has(run.status)) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'Monid returned an unknown run status.');
    if (run.status !== 'COMPLETED') {
      const code = run.status === 'TIMED_OUT' ? 'PROVIDER_TIMEOUT' : run.status === 'BLOCKED' ? 'PROVIDER_BLOCKED' : 'PROVIDER_FAILED';
      throw providerError(run.status === 'TIMED_OUT' ? 504 : 503, code, `The provider run ended with status ${run.status}.`, { runId: run.runId, status: run.status });
    }
    const upstreamStatus = run.providerResponse?.httpStatus ?? 200;
    if (!Number.isInteger(upstreamStatus)) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'Monid omitted the provider status.');
    if (upstreamStatus < 200 || upstreamStatus >= 300) throw mapHttpFailure(upstreamStatus, { runId: run.runId, upstreamStatus });
    return run.output;
  }

  async function run(endpoint, input, signal, operationTimeout) {
    signal?.throwIfAborted();
    const timerController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timerController.signal]) : timerController.signal;
    const timer = setTimeout(() => timerController.abort(providerError(504, 'PROVIDER_TIMEOUT', 'The recipe provider timed out.')), operationTimeout);
    try {
      await verifyFreeEndpoint(endpoint, combined);
      let state = await request('/v1/run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ provider: 'tinyfish', endpoint, input }),
      }, combined);
      let output = evaluate(state);
      while (output === null) {
        if (typeof state.runId !== 'string' || !state.runId) throw providerError(502, 'PROVIDER_BAD_RESPONSE', 'Monid omitted the asynchronous run ID.');
        await delay(pollIntervalMs, combined);
        state = await request(`/v1/runs/${encodeURIComponent(state.runId)}`, {
          method: 'GET', headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
        }, combined);
        output = evaluate(state);
      }
      return output;
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      throw error;
    } finally { clearTimeout(timer); }
  }

  return {
    capabilities: { provider: 'tinyfish', liveSearch: true, renderedFetch: true, authenticated: true, suggest: false },
    async search({ query, count = 6, kind = 'web', signal } = {}) {
      if (!['web', 'recipe'].includes(kind)) throw providerError(400, 'INVALID_KIND', 'Kind must be web or recipe.');
      const normalized = validateQuery(query, count);
      const providerQuery = kind === 'recipe' && !/\brecipes?\b/i.test(normalized) ? `${normalized} recipe` : normalized;
      // Official Monid inspect contract: /search input is queryParams.
      const output = await run('/search', { queryParams: { query: providerQuery, domain_type: 'web' } }, signal, timeoutMs);
      return { query: normalized, provider: 'tinyfish', results: mapSearchOutput(output, count), hasMore: false };
    },
    async suggest({ query, count = 6 } = {}) {
      const normalized = validateQuery(query, count);
      return { query: normalized, provider: 'tinyfish', suggestions: [] };
    },
    async fetchPage(value, { signal, format = 'markdown' } = {}) {
      if (format !== 'markdown') throw providerError(400, 'INVALID_FORMAT', 'TinyFish recipe fetches must use Markdown.');
      const url = validatePublicUrl(value).href;
      // Official Monid inspect contract: /fetch input is body; keep one URL per selection.
      const output = await run('/fetch', { body: { urls: [url], format: 'markdown' } }, signal, fetchTimeoutMs);
      return mapFetchOutput(output, url);
    },
  };
}
