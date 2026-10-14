import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { ApiError } from './errors.js';

const redirects = new Set([301, 302, 303, 307, 308]);
const htmlTypes = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const globalV6 = ipaddr.parseCIDR('2000::/3');
const error = (status, code, message, details) => new ApiError(status, code, message, details);
const hostnameOf = (url) => url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

function parsedAddress(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return ipaddr.parse(value);
  } catch {
    return null;
  }
}

function literalAddress(hostname) {
  const address = parsedAddress(hostname);
  if (!address) return null;
  if (address.kind() === 'ipv4') return { address: address.toString(), family: 4 };
  return { address: hostname, family: 6 };
}

// Use a conservative public-address policy, including IPv4 hidden in IPv6 literals
// and unusual decimal/octal/hex or shorthand IPv4 notations.
export function isPublicAddress(value) {
  let address = parsedAddress(value);
  if (!address) return false;
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  if (address.kind() === 'ipv6' && !address.match(globalV6)) return false;
  return address.range() === 'unicast';
}

function validDomain(hostname) {
  return hostname.length <= 253 && hostname.includes('.') && hostname.split('.').every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

function domainAllowed(hostname, allowedDomains) {
  if (!Array.isArray(allowedDomains)) {
    throw error(500, 'INVALID_FETCH_CONFIGURATION', 'Allowed domains must be an array.');
  }
  const rules = allowedDomains.map((entry) => {
    if (typeof entry !== 'string') throw error(500, 'INVALID_FETCH_CONFIGURATION', 'Invalid allowed domain.');
    const normalized = entry.trim().toLowerCase().replace(/\.$/, '');
    const subdomains = normalized.startsWith('*.');
    const domain = normalized.slice(subdomains ? 2 : 0).replace(/^\[|\]$/g, '');
    if ((!validDomain(domain) && !isIP(domain)) || (subdomains && isIP(domain))) {
      throw error(500, 'INVALID_FETCH_CONFIGURATION', 'Allowed domains must be hosts or explicit *.host patterns.');
    }
    return { domain, subdomains };
  });
  return rules.length === 0 || rules.some(({ domain, subdomains }) =>
    subdomains ? hostname.endsWith(`.${domain}`) : hostname === domain,
  );
}

/** Exact hosts match only themselves; *.example.com matches subdomains, not the apex. */
export function validatePublicUrl(value, { allowedDomains = [] } = {}) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw error(400, 'INVALID_URL', 'Provide a valid absolute recipe URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw error(400, 'UNSAFE_URL', 'Recipe URLs must use HTTP or HTTPS.');
  }
  if (url.username || url.password) throw error(400, 'UNSAFE_URL', 'Recipe URLs cannot include credentials.');
  if (url.port && !['80', '443'].includes(url.port)) {
    throw error(400, 'UNSAFE_URL', 'Recipe URLs may use only ports 80 and 443.');
  }
  const hostname = hostnameOf(url);
  if (literalAddress(hostname)) {
    if (!isPublicAddress(hostname)) throw error(400, 'UNSAFE_URL', 'Recipe URLs must address the public Internet.');
  } else if (!validDomain(hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(hostname)) {
    throw error(400, 'UNSAFE_URL', 'Recipe URLs must use a public hostname.');
  }
  if (!domainAllowed(hostname, allowedDomains)) throw error(403, 'DOMAIN_NOT_ALLOWED', 'This recipe source is not enabled.');
  url.hash = '';
  return url;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason;
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Attach both handlers even when already aborted, so a later DNS rejection is consumed.
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function resolvePublic(url, lookup, signal) {
  const hostname = hostnameOf(url);
  const literal = literalAddress(hostname);
  if (literal) return [literal];
  let addresses;
  try {
    addresses = await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch (cause) {
    throwIfAborted(signal);
    throw error(502, 'DNS_LOOKUP_FAILED', 'The recipe source hostname could not be resolved.');
  }
  throwIfAborted(signal);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw error(502, 'DNS_LOOKUP_FAILED', 'The recipe source hostname has no addresses.');
  }
  if (addresses.some((entry) => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) {
    throw error(400, 'UNSAFE_URL', 'The recipe source resolves to a non-public address.');
  }
  return addresses;
}

function requestPage(url, addresses, { request, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    let req, response, settled = false;
    const finish = (failure, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      response?.destroy();
      req?.destroy();
      if (failure) reject(failure);
      else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    try {
      req = request(url, {
        method: 'GET',
        agent: false,
        headers: {
          accept: 'text/html, application/xhtml+xml, text/plain;q=0.5',
          'accept-encoding': 'identity',
          'user-agent': 'MiseStudioRecipeImporter/0.1',
        },
        // Keep Host and TLS SNI from the original URL, but never resolve again in the socket.
        lookup(_hostname, options, callback) {
          const selected = addresses[0];
          if (options?.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      }, (res) => {
        response = res;
        res.on('error', () => finish(error(502, 'UPSTREAM_READ_FAILED', 'The recipe page could not be read.')));
        res.on('aborted', () => finish(error(502, 'UPSTREAM_READ_FAILED', 'The recipe source ended the response early.')));
        if (settled) return res.destroy();
        const status = res.statusCode;
        if (redirects.has(status)) {
          if (typeof res.headers.location !== 'string' || !res.headers.location) {
            return finish(error(502, 'INVALID_REDIRECT', 'The recipe source sent an invalid redirect.'));
          }
          return finish(null, { redirect: res.headers.location });
        }
        if (status === 401 || status === 403) {
          return finish(error(502, 'SOURCE_BLOCKED', 'The recipe source requires access or blocks automated requests.', { upstreamStatus: status }));
        }
        if (status === 429) {
          return finish(error(503, 'SOURCE_RATE_LIMITED', 'The recipe source is rate limiting requests.', { upstreamStatus: status }));
        }
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          return finish(error(502, 'UPSTREAM_HTTP_ERROR', 'The recipe source could not return the page.', { upstreamStatus: status }));
        }
        const encoding = res.headers['content-encoding'];
        if (encoding && String(encoding).trim().toLowerCase() !== 'identity') {
          return finish(error(422, 'UNSUPPORTED_ENCODING', 'The recipe source sent unsupported compressed content.'));
        }
        const contentType = res.headers['content-type'];
        if (typeof contentType !== 'string' || !htmlTypes.has(contentType.split(';')[0].trim().toLowerCase())) {
          return finish(error(422, 'UNSUPPORTED_CONTENT_TYPE', 'The recipe URL must return an HTML or text page.'));
        }
        const declaredBytes = res.headers['content-length'];
        if (declaredBytes !== undefined && /^\d+$/.test(String(declaredBytes)) && Number(declaredBytes) > maxBytes) {
          return finish(error(413, 'RESPONSE_TOO_LARGE', 'The recipe page exceeds the import size limit.'));
        }
        const charsetMatch = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType);
        const charset = charsetMatch ? charsetMatch[1] ?? charsetMatch[2] ?? charsetMatch[3] : 'utf-8';
        let decoder;
        try { decoder = new TextDecoder(charset, { fatal: true }); }
        catch { return finish(error(422, 'UNSUPPORTED_CHARSET', 'The recipe page uses an unsupported text encoding.')); }
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) return finish(error(413, 'RESPONSE_TOO_LARGE', 'The recipe page exceeds the import size limit.'));
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (settled) return;
          if (!bytes) return finish(error(422, 'EMPTY_RESPONSE', 'The recipe source returned an empty page.'));
          try { finish(null, { html: decoder.decode(Buffer.concat(chunks, bytes)) }); }
          catch { finish(error(422, 'INVALID_TEXT_ENCODING', 'The recipe page does not match its text encoding.')); }
        });
      });
      req.on('error', () => finish(error(502, 'UPSTREAM_REQUEST_FAILED', 'The recipe source could not be reached.')));
      if (settled) req.destroy();
      else req.end();
    } catch {
      finish(error(502, 'UPSTREAM_REQUEST_FAILED', 'The recipe source could not be reached.'));
    }
  });
}

// Dependency injection is factory-scoped. The production export always uses Node DNS and transport.
export function createSafeFetcher({ lookup = dnsLookup, request = (url, options, callback) =>
  (url.protocol === 'https:' ? https : http).request(url, options, callback) } = {}) {
  return async function fetchPage(value, {
    signal: callerSignal, timeoutMs = 10_000, maxBytes = 2_000_000,
    maxRedirects = 3, allowedDomains = [],
  } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxRedirects) || maxRedirects < 0) {
      throw error(500, 'INVALID_FETCH_CONFIGURATION', 'Invalid recipe fetch limits.');
    }
    const controller = new AbortController();
    const { signal } = controller;
    const callerAbort = () => controller.abort(error(499, 'REQUEST_ABORTED', 'The recipe request was cancelled.'));
    callerSignal?.addEventListener('abort', callerAbort, { once: true });
    if (callerSignal?.aborted) callerAbort();
    const timer = setTimeout(() => controller.abort(error(504, 'FETCH_TIMEOUT', 'The recipe source took too long to respond.')), timeoutMs);
    try {
      throwIfAborted(signal);
      let url = validatePublicUrl(value, { allowedDomains });
      for (let count = 0; ; count++) {
        throwIfAborted(signal);
        const addresses = await resolvePublic(url, lookup, signal);
        const result = await requestPage(url, addresses, { request, signal, maxBytes });
        throwIfAborted(signal);
        if (!result.redirect) return { html: result.html, url: url.href };
        if (count >= maxRedirects) throw error(502, 'TOO_MANY_REDIRECTS', 'The recipe source redirected too many times.');
        let target;
        try { target = new URL(result.redirect, url).href; }
        catch { throw error(502, 'INVALID_REDIRECT', 'The recipe source sent an invalid redirect.'); }
        url = validatePublicUrl(target, { allowedDomains });
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', callerAbort);
    }
  };
}

export const fetchRecipePage = createSafeFetcher();
