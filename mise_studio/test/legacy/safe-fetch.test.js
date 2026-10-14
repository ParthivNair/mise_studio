import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSafeFetcher, isPublicAddress, validatePublicUrl } from '../../lib/recipes/legacy/safe-fetch.js';

const publicAddresses = [{ address: '93.184.216.34', family: 4 }];
const code = (expected) => (err) => err.code === expected && Number.isInteger(err.status);

function fixture(pages = [{}], lookup = async () => publicAddresses) {
  const calls = [];
  const fetch = createSafeFetcher({
    lookup,
    request(url, options, callback) {
      const page = pages[calls.length] ?? {};
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = () => queueMicrotask(() => {
        if (page.requestError) return req.emit('error', new Error('network failure'));
        if (page.noResponse || req.destroyed) return;
        const res = new PassThrough();
        res.statusCode = page.status ?? 200;
        res.headers = { 'content-type': 'text/html; charset=utf-8', ...page.headers };
        calls.at(-1).response = res;
        callback(res);
        if (res.destroyed) return;
        if (page.abortResponse) return res.emit('aborted');
        if (page.holdBody) return;
        for (const chunk of page.chunks ?? [page.body ?? '<html>Recipe</html>']) {
          if (!res.destroyed) res.write(chunk);
        }
        if (!res.destroyed) res.end();
      });
      calls.push({ url, options, request: req });
      return req;
    },
  });
  return { fetch, calls };
}

test('URL validation permits ordinary public URLs and removes fragments', () => {
  assert.equal(validatePublicUrl('https://recipes.example.com/meal?q=one#recipe').href, 'https://recipes.example.com/meal?q=one');
  assert.equal(validatePublicUrl('http://8.8.8.8:80/').href, 'http://8.8.8.8/');
  assert.equal(validatePublicUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
});

test('URL validation rejects credentials, local hosts, non-web protocols and unexpected ports', () => {
  for (const url of [
    'file:///etc/passwd', 'ftp://example.com/recipe', 'https://user:password@example.com/',
    'https://example.com:8443/', 'http://localhost/', 'http://localhost./',
    'http://sub.localhost/', 'http://printer/', 'http://dish.local/', 'http://x.internal/',
    'http://service.home.arpa/', 'http://x.invalid/', 'http://x.test/',
  ]) assert.throws(() => validatePublicUrl(url), code('UNSAFE_URL'), url);
  for (const url of ['', '/recipes/one', ' https://example.com/', 'https://example.com/\nrecipe']) {
    assert.throws(() => validatePublicUrl(url), code('INVALID_URL'), url);
  }
});

test('public address checks reject private, mapped private, reserved and encoded literal addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '::', '::1', '::1234', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', '3fff::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const literal of ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validatePublicUrl(`http://${literal}/`), code('UNSAFE_URL'), literal);
  }
});

test('allowed domains use exact hosts or explicit subdomain patterns with label boundaries', () => {
  assert.equal(validatePublicUrl('https://recipes.example.com/', { allowedDomains: ['recipes.example.com'] }).hostname, 'recipes.example.com');
  assert.equal(validatePublicUrl('https://deep.recipes.example.com/', { allowedDomains: ['*.example.com'] }).hostname, 'deep.recipes.example.com');
  for (const host of ['example.com', 'badexample.com', 'example.com.evil.org']) {
    assert.throws(() => validatePublicUrl(`https://${host}/`, { allowedDomains: ['*.example.com'] }), code('DOMAIN_NOT_ALLOWED'));
  }
  assert.throws(() => validatePublicUrl('https://sub.example.com/', { allowedDomains: ['example.com'] }), code('DOMAIN_NOT_ALLOWED'));
  assert.throws(() => validatePublicUrl('https://example.com/', { allowedDomains: ['https://example.com'] }), code('INVALID_FETCH_CONFIGURATION'));
});

test('successful fetch pins the validated DNS address and disables connection reuse', async () => {
  const lookups = [];
  const { fetch, calls } = fixture([{}], async (host, options) => {
    lookups.push({ host, options });
    return [...publicAddresses, { address: '2606:4700:4700::1111', family: 6 }];
  });
  assert.deepEqual(await fetch('https://recipes.example.com/food#recipe'), { html: '<html>Recipe</html>', url: 'https://recipes.example.com/food' });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].options.all, true);
  const { options, request } = calls[0];
  assert.equal(options.agent, false);
  assert.equal(options.headers['accept-encoding'], 'identity');
  options.lookup('recipes.example.com', {}, (err, address, family) => {
    assert.equal(err, null); assert.equal(address, publicAddresses[0].address); assert.equal(family, 4);
  });
  options.lookup('recipes.example.com', { all: true }, (err, addresses) => {
    assert.equal(err, null); assert.deepEqual(addresses, publicAddresses);
  });
  assert.equal(request.destroyed, true);
});

test('literal public IPs bypass DNS but remain validated', async () => {
  const { fetch } = fixture([{}], async () => { throw new Error('DNS must not run'); });
  assert.equal((await fetch('https://8.8.8.8/')).html, '<html>Recipe</html>');
});

test('DNS failures, empty answers and mixed public/private answers never reach transport', async () => {
  for (const answers of [[], [...publicAddresses, { address: '127.0.0.1', family: 4 }], [{ address: '::ffff:169.254.169.254', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const { fetch, calls } = fixture([], async () => answers);
    await assert.rejects(fetch('https://recipes.example.com/'), code(answers.length ? 'UNSAFE_URL' : 'DNS_LOOKUP_FAILED'));
    assert.equal(calls.length, 0);
  }
  const { fetch, calls } = fixture([], async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(fetch('https://recipes.example.com/'), code('DNS_LOOKUP_FAILED'));
  assert.equal(calls.length, 0);
});

test('redirects resolve relative locations and revalidate every destination', async () => {
  const hosts = [];
  const { fetch, calls } = fixture([
    { status: 302, headers: { location: '/second' } },
    { status: 307, headers: { location: 'https://other.example.com/recipe' } },
    { body: 'final recipe' },
  ], async (host) => { hosts.push(host); return publicAddresses; });
  assert.deepEqual(await fetch('https://recipes.example.com/first'), { html: 'final recipe', url: 'https://other.example.com/recipe' });
  assert.deepEqual(hosts, ['recipes.example.com', 'recipes.example.com', 'other.example.com']);
  assert.ok(calls.every((call) => call.request.destroyed));
  for (const location of ['http://127.0.0.1/', 'https://user:pass@example.com/', 'file:///etc/passwd']) {
    const unsafe = fixture([{ status: 302, headers: { location } }]);
    await assert.rejects(unsafe.fetch('https://recipes.example.com/'), code('UNSAFE_URL'));
    assert.equal(unsafe.calls.length, 1);
  }
});

test('redirects cannot escape domain restrictions or rebind to a private address', async () => {
  const domains = fixture([{ status: 302, headers: { location: 'https://elsewhere.example.org/' } }]);
  await assert.rejects(domains.fetch('https://recipes.example.com/', { allowedDomains: ['recipes.example.com'] }), code('DOMAIN_NOT_ALLOWED'));
  let lookups = 0;
  const rebound = fixture([{ status: 302, headers: { location: '/second' } }], async () =>
    ++lookups === 1 ? publicAddresses : [{ address: '10.0.0.1', family: 4 }]);
  await assert.rejects(rebound.fetch('https://recipes.example.com/'), code('UNSAFE_URL'));
  assert.equal(rebound.calls.length, 1);
});

test('redirect count and missing locations produce useful errors', async () => {
  const loop = fixture([{ status: 301, headers: { location: '/again' } }]);
  await assert.rejects(loop.fetch('https://recipes.example.com/', { maxRedirects: 0 }), code('TOO_MANY_REDIRECTS'));
  const missing = fixture([{ status: 302 }]);
  await assert.rejects(missing.fetch('https://recipes.example.com/'), code('INVALID_REDIRECT'));
});

test('response byte limits apply to declared and streamed sizes and close the request', async () => {
  for (const page of [
    { headers: { 'content-length': '200' } },
    { chunks: ['12345', '67890', 'x'] },
    { chunks: [Buffer.from('éééééé')] },
  ]) {
    const { fetch, calls } = fixture([page]);
    await assert.rejects(fetch('https://recipes.example.com/', { maxBytes: 10 }), code('RESPONSE_TOO_LARGE'));
    assert.equal(calls[0].request.destroyed, true);
    assert.equal(calls[0].response.destroyed, true);
  }
  assert.equal((await fixture([{ body: '1234567890' }]).fetch('https://recipes.example.com/', { maxBytes: 10 })).html, '1234567890');
});

test('content types, compression, charset and invalid text are checked', async () => {
  for (const [page, expected] of [
    [{ headers: { 'content-type': 'application/json' } }, 'UNSUPPORTED_CONTENT_TYPE'],
    [{ headers: { 'content-type': undefined } }, 'UNSUPPORTED_CONTENT_TYPE'],
    [{ headers: { 'content-encoding': 'gzip' } }, 'UNSUPPORTED_ENCODING'],
    [{ headers: { 'content-type': 'text/html; charset=bogus' } }, 'UNSUPPORTED_CHARSET'],
    [{ body: Buffer.from([0xff]) }, 'INVALID_TEXT_ENCODING'],
    [{ body: '' }, 'EMPTY_RESPONSE'],
  ]) await assert.rejects(fixture([page]).fetch('https://recipes.example.com/'), code(expected));
  assert.equal((await fixture([{ headers: { 'content-type': 'text/plain; charset="windows-1252"' }, body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }]).fetch('https://recipes.example.com/')).html, 'café');
  assert.equal((await fixture([{ headers: { 'content-type': 'application/xhtml+xml' } }]).fetch('https://recipes.example.com/')).html, '<html>Recipe</html>');
});

test('upstream access blocks, rate limits, errors and broken streams remain distinguishable', async () => {
  for (const [page, expected] of [
    [{ status: 401 }, 'SOURCE_BLOCKED'], [{ status: 403 }, 'SOURCE_BLOCKED'],
    [{ status: 429 }, 'SOURCE_RATE_LIMITED'], [{ status: 500 }, 'UPSTREAM_HTTP_ERROR'],
    [{ status: 404 }, 'UPSTREAM_HTTP_ERROR'], [{ requestError: true }, 'UPSTREAM_REQUEST_FAILED'],
    [{ abortResponse: true }, 'UPSTREAM_READ_FAILED'],
  ]) await assert.rejects(fixture([page]).fetch('https://recipes.example.com/'), code(expected));
});

test('one timeout covers stalled DNS, response headers and response bodies', async () => {
  const dns = fixture([], () => new Promise(() => {}));
  await assert.rejects(dns.fetch('https://recipes.example.com/', { timeoutMs: 15 }), code('FETCH_TIMEOUT'));
  assert.equal(dns.calls.length, 0);
  for (const page of [{ noResponse: true }, { holdBody: true }]) {
    const { fetch, calls } = fixture([page]);
    await assert.rejects(fetch('https://recipes.example.com/', { timeoutMs: 15 }), code('FETCH_TIMEOUT'));
    assert.equal(calls[0].request.destroyed, true);
  }
});

test('deadline spans redirects rather than resetting for each hop', async () => {
  let lookups = 0;
  const { fetch, calls } = fixture([{ status: 302, headers: { location: '/second' } }], async () => {
    lookups++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return publicAddresses;
  });
  await assert.rejects(fetch('https://recipes.example.com/', { timeoutMs: 40 }), code('FETCH_TIMEOUT'));
  assert.equal(lookups, 2);
  assert.equal(calls.length, 1);
});

test('caller abort works before starting, during DNS and while reading', async () => {
  const pre = new AbortController(); pre.abort();
  const before = fixture();
  await assert.rejects(before.fetch('https://recipes.example.com/', { signal: pre.signal }), code('REQUEST_ABORTED'));
  assert.equal(before.calls.length, 0);
  for (const duringDns of [true, false]) {
    const controller = new AbortController();
    const { fetch, calls } = fixture([{ holdBody: true }], duringDns ? () => new Promise(() => {}) : async () => publicAddresses);
    const pending = fetch('https://recipes.example.com/', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, code('REQUEST_ABORTED'));
    if (!duringDns) assert.equal(calls[0].request.destroyed, true);
  }
});

test('invalid resource limits are configuration errors', async () => {
  for (const options of [{ timeoutMs: 0 }, { maxBytes: -1 }, { maxRedirects: -1 }, { maxBytes: Infinity }]) {
    await assert.rejects(fixture().fetch('https://recipes.example.com/', options), code('INVALID_FETCH_CONFIGURATION'));
  }
});
