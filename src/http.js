/**
 * Polite HTTP. Built-in fetch only, no HTTP client dependency.
 *
 * Crawl policy for animefillerlist.com (robots.txt read 2026-08-01):
 *   - /shows and /shows/* are allowed.
 *   - The site sets a site-wide `Crawl-delay: 10`.
 * We honour that: 10s between requests by default. The delay is configurable
 * upwards via CRAWL_DELAY_MS but the default is never lowered, and a run
 * aborts cleanly rather than retrying forever against a struggling host.
 */

export const DEFAULT_CRAWL_DELAY_MS = 10_000;

export const USER_AGENT =
  'filler-scrape/1.0 (+https://github.com/nickEatsBread/filler-scrape) - weekly filler-episode index builder; honours robots.txt Crawl-delay';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises requests to one host and guarantees a minimum gap between them.
 */
export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.chain = Promise.resolve();
  }

  /** Run `fn` after the minimum interval has elapsed since the previous run. */
  schedule(fn) {
    const run = async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    };
    const result = this.chain.then(run, run);
    // Keep the chain alive even when a call rejects.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Push the next allowed request time out by `ms` (used for Retry-After). */
  penalise(ms) {
    this.last = Math.max(this.last, Date.now() - this.minIntervalMs + ms);
  }
}

export class HttpError extends Error {
  /**
   * `retryAfterMs` carries the server's Retry-After through the throw so a
   * caller that runs its own retry loop (the AniList client) can honour it.
   * Without it a 429 whose retry budget is 60s would be retried in ~4s.
   */
  constructor(status, url, body, retryAfterMs = null) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Exponential backoff schedule with full jitter, capped.
 * attempt is 0-based.
 */
export function backoffMs(attempt, base = 2000, cap = 120_000) {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * fetch with retry on 429 and 5xx, honouring Retry-After.
 * 4xx other than 429 fail immediately - retrying a 404 is pointless.
 *
 * Throws after `retries` exhausted so the caller can abort the run instead of
 * hammering the host.
 *
 * `limiter` is REQUIRED, and that is a politeness decision rather than an
 * ergonomic one. This module's whole job is to not hammer a host that asked
 * for 10 seconds between requests, so the throttle must never be something a
 * caller obtains by forgetting an option. Unthrottled is still reachable -
 * `limiter: null` - but it has to be typed out, which is exactly the point:
 * it appears in the diff and in review. Omitting the key is a TypeError.
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    retries = 4,
    limiter,
    timeoutMs = 30_000,
    headers = {},
    onRetry = () => {},
    ...rest
  } = options;

  if (!Object.hasOwn(options, 'limiter')) {
    throw new TypeError(
      'fetchWithRetry(): a `limiter` is required. Pass a RateLimiter, ' +
        'or `limiter: null` to deliberately fetch unthrottled.',
    );
  }
  if (limiter !== null && typeof limiter?.schedule !== 'function') {
    throw new TypeError('fetchWithRetry(): `limiter` must be a RateLimiter (or null), got ' + typeof limiter);
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const doFetch = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          ...rest,
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en', ...headers },
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let response;
    try {
      response = limiter ? await limiter.schedule(doFetch) : await doFetch();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const wait = backoffMs(attempt);
      onRetry({ attempt, wait, reason: err.name === 'AbortError' ? 'timeout' : String(err.message) });
      await sleep(wait);
      continue;
    }

    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const body = await response.text().catch(() => '');
    lastError = new HttpError(response.status, url, body.slice(0, 500), retryAfter);

    if (!retryable || attempt === retries) break;

    const wait = retryAfter ?? backoffMs(attempt);
    if (limiter && response.status === 429) limiter.penalise(wait);
    onRetry({ attempt, wait, reason: `HTTP ${response.status}`, retryAfter: retryAfter != null });
    await sleep(wait);
  }

  throw lastError ?? new Error(`request failed: ${url}`);
}

/**
 * GET a URL and return the response body as text.
 * Options are forwarded to `fetchWithRetry`, so `limiter` is required here too.
 */
export async function fetchText(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  return response.text();
}
