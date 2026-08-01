/**
 * AniList GraphQL client.
 *
 * AniList rate-limits aggressively and answers 429 with Retry-After. We
 * serialise every request through a limiter with a conservative default
 * interval, honour Retry-After exactly, and back off exponentially on 5xx.
 * There is no hot-loop path in here: every retry sleeps first.
 */

import { RateLimiter, fetchWithRetry, sleep, parseRetryAfter, backoffMs, HttpError } from './http.js';

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

/** ~30 requests/minute. AniList's published budget is higher; we stay well under. */
export const DEFAULT_ANILIST_INTERVAL_MS = 2000;

const SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji english native }
      synonyms
      format
      status
      episodes
      seasonYear
      popularity
      isAdult
    }
  }
}`;

/**
 * Fetch one entry by id. Used to check a hand-pinned override against the
 * episode-count guard: a pin says WHICH entry, it does not say the numbering
 * lines up, and nobody re-derives that by hand a year later.
 */
const MEDIA_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english native }
    synonyms
    format
    status
    episodes
    seasonYear
  }
}`;

export class AniListClient {
  constructor({ intervalMs = DEFAULT_ANILIST_INTERVAL_MS, log = () => {} } = {}) {
    this.limiter = new RateLimiter(intervalMs);
    this.log = log;
    this.cache = new Map();
  }

  async query(query, variables, { retries = 5 } = {}) {
    // The query text is part of the key: two different queries with the same
    // variables are not the same request.
    const key = JSON.stringify([query, variables]);
    if (this.cache.has(key)) return this.cache.get(key);

    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetchWithRetry(ANILIST_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
          limiter: this.limiter,
          retries: 0, // retry policy lives here so we can read GraphQL errors too
        });
      } catch (err) {
        if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) {
          if (attempt === retries) throw err;
          // AniList answers 429 with Retry-After (usually 60s). Honour it
          // exactly; only fall back to backoff when the header is absent.
          const wait = err.retryAfterMs ?? backoffMs(attempt, 5000);
          this.log(`anilist ${err.status}; backing off ${Math.round(wait / 1000)}s`);
          this.limiter.penalise(wait);
          await sleep(wait);
          continue;
        }
        throw err;
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      // `Number(null)` is 0, so an ABSENT header must be treated as "unknown"
      // explicitly - otherwise every response without the header looks like an
      // exhausted budget and parks the run for a minute.
      const remainingHeader = response.headers.get('x-ratelimit-remaining');
      const remaining = remainingHeader == null || remainingHeader === '' ? NaN : Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining <= 2) {
        // Nearly out of budget: idle for the rest of the window before continuing.
        const wait = (retryAfter ?? 60_000) + 1000;
        this.log(`anilist budget nearly exhausted (${remaining} left); pausing ${Math.round(wait / 1000)}s`);
        this.limiter.penalise(wait);
      }

      const payload = await response.json();

      if (payload.errors?.length) {
        const status = payload.errors[0]?.status;
        if (status === 429 || (typeof status === 'number' && status >= 500)) {
          if (attempt === retries) {
            // Carry the status on the throw. AniList reports rate limiting as
            // a 200 with a GraphQL error, so without this the orchestrator
            // cannot tell "this show failed" from "stop crawling".
            const err = new Error(`AniList error: ${payload.errors[0]?.message}`);
            err.status = status;
            throw err;
          }
          const wait = retryAfter ?? backoffMs(attempt, 5000);
          this.log(`anilist GraphQL ${status}; backing off ${Math.round(wait / 1000)}s`);
          this.limiter.penalise(wait);
          await sleep(wait);
          continue;
        }
        // 404 "Not Found" is a normal empty result for a search miss.
        if (status === 404) {
          this.cache.set(key, { Page: { media: [] } });
          return this.cache.get(key);
        }
        throw new Error(`AniList error: ${payload.errors.map((e) => e.message).join('; ')}`);
      }

      this.cache.set(key, payload.data);
      return payload.data;
    }

    throw new Error('AniList query exhausted retries');
  }

  /** Search anime by title. Returns an array of media objects (possibly empty). */
  async search(title, { perPage = 10 } = {}) {
    const term = String(title || '').trim();
    if (!term) return [];
    const data = await this.query(SEARCH_QUERY, { search: term, perPage });
    return data?.Page?.media ?? [];
  }

  /**
   * Look one anime up by id. Returns the media object, or null when AniList
   * has no such entry (it answers a missing id with a 404 GraphQL error, which
   * `query` already treats as an empty result rather than a failure).
   */
  async media(id) {
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    const data = await this.query(MEDIA_QUERY, { id: numeric });
    return data?.Media ?? null;
  }
}
