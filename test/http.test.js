import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError, RateLimiter, backoffMs, fetchText, fetchWithRetry, parseRetryAfter } from '../src/http.js';
import { AniListClient } from '../src/anilist.js';

/** Swap in a stub fetch for the duration of `fn`. */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('parseRetryAfter reads delta-seconds and HTTP-dates', () => {
  assert.equal(parseRetryAfter('60'), 60_000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  const future = new Date(Date.now() + 30_000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms > 20_000 && ms <= 31_000, `expected ~30s, got ${ms}`);
});

test('backoffMs grows and stays inside the cap', () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ms = backoffMs(attempt);
    assert.ok(ms > 0 && ms <= 120_000, `attempt ${attempt} produced ${ms}`);
  }
  assert.ok(backoffMs(0) < backoffMs(5));
});

test('the rate limiter serialises requests and holds the minimum gap', async () => {
  const at = [];
  await withFetch(
    async () => {
      at.push(Date.now());
      return new Response('ok', { status: 200 });
    },
    async () => {
      const limiter = new RateLimiter(120);
      await Promise.all([1, 2, 3].map(() => fetchWithRetry('https://example.invalid/', { limiter })));
    },
  );
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] - at[i - 1] >= 110, `gap ${i} was only ${at[i] - at[i - 1]}ms`);
  }
});

test('an unthrottled fetch cannot be obtained by leaving the limiter out', async () => {
  // The safe default was inverted: `limiter` defaulted to null, so the one
  // module whose entire job is honouring a 10s Crawl-delay handed out an
  // unthrottled fetcher to anyone who forgot an option. Omission is now an
  // error, so hitting the site flat out has to be *written*.
  await withFetch(
    () => assert.fail('an unthrottled request must never be issued by omission'),
    async () => {
      await assert.rejects(
        () => fetchWithRetry('https://example.invalid/'),
        (err) => err instanceof TypeError && /limiter/.test(err.message),
        'no options at all must be refused',
      );
      await assert.rejects(
        () => fetchWithRetry('https://example.invalid/', { retries: 3 }),
        (err) => err instanceof TypeError && /limiter/.test(err.message),
        'other options without a limiter must be refused',
      );
      await assert.rejects(
        () => fetchText('https://example.invalid/', {}),
        (err) => err instanceof TypeError && /limiter/.test(err.message),
        'fetchText forwards its options, so it inherits the requirement',
      );
      // And a value that is not a limiter is a typo, not a limiter.
      for (const notALimiter of [{}, 'RateLimiter', 10_000, true, []]) {
        await assert.rejects(
          () => fetchWithRetry('https://example.invalid/', { limiter: notALimiter }),
          (err) => err instanceof TypeError && /limiter/.test(err.message),
          `limiter=${JSON.stringify(notALimiter)} must be refused`,
        );
      }
    },
  );
});

test('an unthrottled fetch is still available, but only by asking for it explicitly', async () => {
  // The AniList client and the site fetcher both pass a real limiter; this is
  // the escape hatch for everything else, and it is deliberately verbose.
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response('ok', { status: 200 });
    },
    async () => {
      const body = await fetchText('https://example.invalid/', { limiter: null });
      assert.equal(body, 'ok');
    },
  );
  assert.equal(calls, 1);
});

test('a 4xx that is not 429 fails immediately instead of being retried', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response('gone', { status: 404 });
    },
    async () => {
      await assert.rejects(
        () => fetchWithRetry('https://example.invalid/', { retries: 3, limiter: null }),
        (err) => err instanceof HttpError && err.status === 404,
      );
    },
  );
  assert.equal(calls, 1, 'a 404 must not be retried');
});

test('HttpError carries the server Retry-After through the throw', async () => {
  await withFetch(
    async () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }),
    async () => {
      await assert.rejects(
        () => fetchWithRetry('https://example.invalid/', { retries: 0, limiter: null }),
        (err) => {
          assert.ok(err instanceof HttpError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterMs, 60_000, 'Retry-After must survive the throw');
          return true;
        },
      );
    },
  );
});

test('the AniList client honours Retry-After on an HTTP 429 instead of fast-retrying', async () => {
  const at = [];
  await withFetch(
    async () => {
      at.push(Date.now());
      return new Response(JSON.stringify({ errors: [{ message: 'Too Many Requests', status: 429 }] }), {
        status: 429,
        headers: { 'retry-after': '2', 'content-type': 'application/json' },
      });
    },
    async () => {
      const client = new AniListClient({ intervalMs: 0 });
      await assert.rejects(() => client.query('query { x }', { search: 'Naruto' }, { retries: 1 }));
    },
  );
  // The single retry must wait the advertised 2s, not the ~2.5s-and-shrinking
  // exponential backoff that ignored the header.
  assert.equal(at.length, 2, 'expected exactly one retry');
  assert.ok(at[1] - at[0] >= 1900, `retry came after only ${at[1] - at[0]}ms`);
});

test('an absent x-ratelimit-remaining header is not read as a zero budget', async () => {
  // Number(null) is 0, so a missing header used to look like an exhausted
  // budget and parked the limiter for a minute after every single response.
  const started = Date.now();
  await withFetch(
    async () =>
      new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    async () => {
      const client = new AniListClient({ intervalMs: 0 });
      await client.query('query A { a }', { search: 'a' });
      await client.query('query A { a }', { search: 'b' });
    },
  );
  assert.ok(Date.now() - started < 5000, `two header-less responses took ${Date.now() - started}ms`);
});

test('a low x-ratelimit-remaining still parks the limiter', async () => {
  const at = [];
  await withFetch(
    async () => {
      at.push(Date.now());
      return new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '1', 'retry-after': '1' },
      });
    },
    async () => {
      const client = new AniListClient({ intervalMs: 0 });
      await client.query('query A { a }', { search: 'a' });
      await client.query('query A { a }', { search: 'b' });
    },
  );
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 1900, `expected a pause after a near-exhausted budget, got ${at[1] - at[0]}ms`);
});

test('an AniList id lookup returns the entry, and null when there is no such entry', async () => {
  // Used to check a hand-pinned override against the episode-count guard, so
  // "no such id" has to be a clean null rather than a throw - a typo'd pin is
  // reported, not an exception that takes the run down.
  await withFetch(
    async (url, init) => {
      const { variables } = JSON.parse(init.body);
      const payload =
        variables.id === 20
          ? { data: { Media: { id: 20, title: { romaji: 'Naruto' }, format: 'TV', episodes: 220 } } }
          : { errors: [{ message: 'Not Found', status: 404 }] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      const client = new AniListClient({ intervalMs: 0 });
      assert.equal((await client.media(20)).episodes, 220);
      assert.equal(await client.media(999999), null, 'a missing id is null, not a throw');
      // A junk id is refused before it costs a request.
      for (const junk of [0, -1, 1.5, 'twenty', null, undefined, true]) {
        assert.equal(await client.media(junk), null, `media(${JSON.stringify(junk)}) must be null`);
      }
    },
  );
});

test('the AniList response cache keys on the query text as well as the variables', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      const client = new AniListClient({ intervalMs: 0 });
      await client.query('query A { a }', { search: 'x' });
      await client.query('query A { a }', { search: 'x' });
      assert.equal(calls, 1, 'the identical query must be served from cache');
      await client.query('query B { b }', { search: 'x' });
      assert.equal(calls, 2, 'a different query with the same variables is a different request');
    },
  );
});
