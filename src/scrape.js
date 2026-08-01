/**
 * Orchestrator: crawl animefillerlist.com, resolve each show to an AniList
 * media id, and write filler.json / mapping.json / unmatched.json.
 *
 * Everything with interesting logic lives in parse.js and match.js so it can
 * be tested without the network. This file is plumbing, politeness and I/O -
 * but the safety decisions it plumbs together (overrides, cache reuse, the
 * overflow re-check, the abort paths) are the highest-consequence code here,
 * so `run()` takes three optional seams, `fetchPage(url)`,
 * `searchAniList(title)` and `lookupAniList(id)`, which default to the real
 * network clients and let the whole orchestration be exercised offline at
 * zero delay.
 *
 * The seams cannot be used to crawl the real site faster: see `injected()`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseShowIndex, parseShowPage } from './parse.js';
import {
  pickMatch,
  buildFillerOutput,
  checkEpisodeAlignment,
  isKnownEpisodeCount,
  TITLE_FIELDS,
  EPISODE_OVERFLOW_TOLERANCE,
} from './match.js';
import { AniListClient, DEFAULT_ANILIST_INTERVAL_MS } from './anilist.js';
import { RateLimiter, fetchText, DEFAULT_CRAWL_DELAY_MS } from './http.js';

export const BASE_URL = 'https://www.animefillerlist.com';

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

/**
 * Is this error an upstream telling us to stop? 429 or 5xx.
 *
 * Both clients only throw these once their own Retry-After-honouring retry
 * budget is spent, so by the time one reaches here the answer is "back off
 * entirely", not "try the next show".
 */
export const isRefusal = (err) => {
  const status = Number(err?.status);
  return status === 429 || (status >= 500 && status < 600);
};

/**
 * Read a value from overrides.json or mapping.json as an AniList id, or null if
 * it is not one.
 *
 * Deliberately stricter than `Number(value)`, which is a trapdoor: `Number(true)`
 * is 1 and `Number(["20"])` is 20, so a hand-edit typo like `"naruto": true`
 * would otherwise be accepted as a valid id and republish that show's filler
 * numbers against a completely unrelated AniList entry. Only a real positive
 * integer, or a string that is exactly one, counts.
 *
 * Both files are on disk, in the repo, and hand-editable, so both are parsed
 * through here. An id is the key of the published filler.json, so anything that
 * is not a positive integer would emit a key no consumer can ever look up.
 */
export function parseAniListId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Why a cached mapping entry may NOT be served from the cache — or null if it
 * may. This is the entire cache-reuse rule.
 *
 * It is an ALLOWLIST, deliberately, and on both halves. A cache hit skips every
 * check the fresh path runs, so the only entry that may be reused is one that
 * can still be JUDGED BY TODAY'S RULES from what was recorded. That takes two
 * things, and the absence of either is a re-resolve:
 *
 *   1. Provenance we recognise as strong: an exact hit on AniList's own romaji
 *      or english title. A denylist ("re-test the synonym ones") got this
 *      exactly backwards, because an absent, null or unrecognised
 *      `matchedField` — which is what older builds wrote — sailed through as a
 *      strong hit. The entries carrying the least evidence were the ones being
 *      trusted the most.
 *   2. An episode count the overflow guard can actually compare. A recorded
 *      `anilistEpisodes` of null makes `checkEpisodeAlignment` answer `unknown`,
 *      and `unknown` is `ok` — so the guard is permanently inert for every show
 *      that was mapped while it was still airing, which is precisely the set of
 *      long-running shows that later outgrow their matched entry. The cron
 *      never passes --refresh, so nothing else would ever revisit it.
 *
 * The cost is one AniList query per weak entry per run — tens of still-airing
 * shows, not the whole ~370-show index — and a re-resolved match records both
 * halves, so a show that has since finished becomes a strong cache hit again
 * and stops costing anything. A show that is still airing keeps returning a
 * null count and keeps re-resolving. That is the intended trade: it is the one
 * show whose numbering can move.
 */
export function cacheReuseBlocker(cached) {
  const matchedField = cached?.matchedField;
  if (!TITLE_FIELDS.includes(matchedField)) {
    return (
      `recorded match provenance ${JSON.stringify(matchedField ?? null)} is not one of ` +
      `${TITLE_FIELDS.join('/')}, so it cannot be trusted as a strong match`
    );
  }
  const anilistEpisodes = cached?.anilistEpisodes;
  if (!isKnownEpisodeCount(anilistEpisodes)) {
    return (
      `recorded AniList episode count ${JSON.stringify(anilistEpisodes ?? null)} cannot be ` +
      'overflow-checked, so the episode-numbering guard would be inert for it'
    );
  }
  return null;
}

/** Parse `--flag value` / `--flag=value` / `--flag` argv. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[token.slice(2)] = argv[++i];
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

/**
 * Build the real page fetcher: one serialised, rate-limited GET of a show page.
 *
 * The crawl-delay floor lives HERE and nowhere else, and it is clamped against
 * a module constant rather than against anything the caller can influence, so
 * no argument to this function can produce a fetcher that crawls faster than
 * the site's stated `Crawl-delay: 10`. The limiter itself is closed over and
 * unreachable from outside.
 */
export function createSiteFetcher({ crawlDelayMs = DEFAULT_CRAWL_DELAY_MS, log = () => {} } = {}) {
  const delay = Math.max(DEFAULT_CRAWL_DELAY_MS, Number(crawlDelayMs) || 0);
  if (delay !== Number(crawlDelayMs)) {
    log(`crawl delay raised to the site's stated minimum of ${delay}ms`);
  }

  const limiter = new RateLimiter(delay);
  const fetchPage = (url) =>
    fetchText(url, {
      limiter,
      onRetry: ({ wait, reason }) => log(`  retry ${url} in ${Math.round(wait / 1000)}s (${reason})`),
    });

  // Frozen so the advertised delay cannot be edited to misreport the real one.
  return Object.freeze(Object.assign(fetchPage, { crawlDelayMs: delay }));
}

/**
 * Build the real AniList seams: `(title) => Promise<media[]>` and
 * `(id) => Promise<media|null>`.
 *
 * Both come from ONE client on purpose. Two clients would mean two limiters
 * and therefore twice the agreed request rate against the same host, which is
 * exactly the sort of accident the single-limiter design exists to prevent.
 */
export function createAniListSeams({ intervalMs = DEFAULT_ANILIST_INTERVAL_MS, log = () => {} } = {}) {
  const client = new AniListClient({ intervalMs, log });
  return {
    searchAniList: (title) => client.search(title),
    lookupAniList: (id) => client.media(id),
  };
}

/**
 * Accept an injected seam only as a live function value.
 *
 * This is what keeps the seam from becoming a politeness bypass in production:
 * a function cannot be expressed in argv or in an environment variable, and
 * `main()` never reads any flag into these options, so the only way to reach
 * the seam is to `import { run }` and hand it a callable. The shipped CLI path
 * (scrape.js -> main(process.argv) -> run) always constructs the real,
 * floor-clamped fetcher itself.
 */
const injected = (name, value) => {
  if (value == null) return null;
  if (typeof value !== 'function') {
    throw new TypeError(`run(): ${name} must be a function; it cannot be supplied from the command line`);
  }
  return value;
};

export async function run(options = {}) {
  const {
    outDir = process.cwd(),
    limit = Infinity,
    only = null, // array of slugs, for smoke tests
    crawlDelayMs = DEFAULT_CRAWL_DELAY_MS,
    anilistIntervalMs = DEFAULT_ANILIST_INTERVAL_MS,
    refresh = false, // re-query AniList even for slugs already in mapping.json
    tolerance = EPISODE_OVERFLOW_TOLERANCE,
    log = console.error,
  } = options;

  // Test seams. Absent (the production path) they default to the real thing.
  const get = injected('fetchPage', options.fetchPage) ?? createSiteFetcher({ crawlDelayMs, log });
  const injectedSearch = injected('searchAniList', options.searchAniList);
  const injectedLookup = injected('lookupAniList', options.lookupAniList);
  // Only build a real client if at least one AniList seam is missing, and
  // build at most one so both seams share its limiter and response cache.
  const real = injectedSearch && injectedLookup ? null : createAniListSeams({ intervalMs: anilistIntervalMs, log });
  const searchAniList = injectedSearch ?? real.searchAniList;
  const lookupAniList = injectedLookup ?? real.lookupAniList;

  /** A message that has to survive a 100k-line Actions log. */
  const shout = (headline, detail = []) => {
    const bar = '*'.repeat(78);
    // Same workflow-command convention scripts/check-regression.js uses, so
    // this also lands as an annotation on the run summary page.
    log(`::warning::${headline}`);
    log(bar);
    log(`* ${headline}`);
    for (const line of detail) log(`* ${line}`);
    log(bar);
  };

  const mappingFile = path.join(outDir, 'mapping.json');
  const overridesFile = path.join(outDir, 'overrides.json');
  const fillerFile = path.join(outDir, 'filler.json');
  const unmatchedFile = path.join(outDir, 'unmatched.json');

  const mapping = await readJson(mappingFile, {});
  const overrides = await readJson(overridesFile, {});

  // Migration. Earlier builds also wrote a `source: 'override'` cache entry for
  // every pinned show. Such an entry is stale by construction and is dropped on
  // read rather than honoured, because it could only ever do harm:
  //   - overrides.json is consulted first on every run, so it is never the
  //     thing that resolves a live pin - it is pure redundancy;
  //   - it outlives the pin, so deleting a line from overrides.json did not
  //     un-pin the show, it just promoted the pin to an ordinary cache hit
  //     that publishes the forced id forever;
  //   - it carries no `anilistEpisodes`, so the cached-path overflow re-check
  //     was permanently inert for that slug.
  // Dropping them here is what makes deleting a line from overrides.json work.
  for (const [slug, entry] of Object.entries(mapping)) {
    if (entry?.source === 'override') {
      delete mapping[slug];
      log(`dropping stale override-sourced mapping.json entry for ${slug}`);
    }
  }

  log(
    typeof get.crawlDelayMs === 'number'
      ? `fetching show index (crawl delay ${get.crawlDelayMs / 1000}s)`
      : 'fetching show index (injected fetcher)',
  );
  const indexHtml = await get(`${BASE_URL}/shows`);
  let shows = parseShowIndex(indexHtml);
  log(`index lists ${shows.length} shows`);

  if (only?.length) {
    const wanted = new Set(only);
    const found = shows.filter((s) => wanted.has(s.slug));
    // Allow smoke-testing a slug that is not in the index snapshot.
    for (const slug of only) {
      if (!found.some((s) => s.slug === slug)) found.push({ slug, title: null });
    }
    shows = found;
  }
  if (Number.isFinite(limit)) shows = shows.slice(0, limit);

  const entries = [];
  const unmatched = {};
  const warnings = [];

  for (const [i, show] of shows.entries()) {
    const { slug } = show;
    log(`[${i + 1}/${shows.length}] ${slug}`);

    let page;
    try {
      const html = await get(`${BASE_URL}/shows/${slug}`);
      page = parseShowPage(html);
    } catch (err) {
      // Abort cleanly rather than hammering a host that is refusing us.
      log(`  fetch failed: ${err.message}`);
      unmatched[slug] = { title: show.title, reason: 'fetch-failed', error: String(err.message) };
      if (isRefusal(err)) {
        log('aborting run: the site is rate-limiting or erroring. Partial results are not written.');
        throw err;
      }
      continue;
    }

    const title = show.title || page.title || slug;
    for (const w of page.warnings) {
      warnings.push(`${slug}: ${w}`);
      log(`  warn: ${w}`);
    }

    // A show with no filler is not an error; it is simply omitted from output.
    if (page.filler.length === 0) {
      log(`  no filler episodes (${page.episodeCount} episodes listed)`);
    } else {
      log(`  ${page.filler.length} filler of ${page.episodeCount} episodes`);
    }

    // 1. Overrides always win.
    if (Object.hasOwn(overrides, slug)) {
      const forced = overrides[slug];
      if (forced === null) {
        log('  excluded by overrides.json');
        unmatched[slug] = { title, reason: 'excluded-by-override', fillerCount: page.filler.length };
        continue;
      }
      const forcedId = parseAniListId(forced);
      if (forcedId === null) {
        // Never let a typo'd override poison mapping.json, and never fall
        // through to automatic matching either: silently matching a slug the
        // human meant to pin would look exactly like the override working.
        log(`  invalid override value ${JSON.stringify(forced)}; expected a positive integer or null`);
        unmatched[slug] = { title, reason: 'invalid-override', value: forced ?? null };
        continue;
      }
      // A pin says WHICH AniList entry, not that the numbering lines up. The
      // same overflow comparison the automatic and cached paths run is run
      // here too - but it cannot veto a human decision, so a failure SHOUTS
      // and publishes anyway. Refusing silently would defeat the operator's
      // stated intent; publishing silently would hide a pin that has rotted
      // because the show kept airing. So: publish, and make it unmissable.
      let warning = null;
      try {
        const media = await lookupAniList(forcedId);
        if (!media) {
          warning = {
            reason: 'override-anilist-id-not-found',
            detail: `AniList has no anime with id ${forcedId}`,
          };
        } else {
          const alignment = checkEpisodeAlignment(page.episodeCount, media, tolerance);
          if (!alignment.ok) {
            warning = {
              reason: 'override-episode-count-overflow',
              detail:
                `the site now lists ${alignment.scrapedEpisodeCount} episodes but AniList ${forcedId} ` +
                `has only ${alignment.anilistEpisodes}; ${alignment.overflow} episode numbers land past its end`,
              alignment,
            };
          }
        }
      } catch (err) {
        // Same rule as everywhere else: one show's error is one show's
        // problem, a refusal is the run's problem.
        if (isRefusal(err)) {
          log(`  anilist lookup failed for override id ${forcedId}: ${err.message}`);
          log('aborting run: AniList is rate-limiting or erroring. Partial results are not written.');
          throw err;
        }
        warning = {
          reason: 'override-check-failed',
          detail: `could not verify AniList ${forcedId} against the scraped episode count: ${err.message}`,
        };
      }

      if (warning) {
        shout(`override ${slug} -> AniList ${forcedId} PUBLISHED WITHOUT A CLEAN CHECK`, [
          warning.detail,
          'It was published anyway because overrides.json pins it: a pin is an explicit decision.',
          'Correct or remove the line in overrides.json if this is wrong.',
        ]);
        warnings.push(`${slug}: ${warning.detail}`);
        // Recorded in the file a human actually reads, flagged `published`
        // so it cannot be mistaken for a show that was dropped.
        unmatched[slug] = {
          title,
          reason: warning.reason,
          published: true,
          anilistId: forcedId,
          note: 'overrides.json pins this id, so it was published despite the failed check; fix the override if it is wrong',
          aflEpisodes: page.episodeCount,
          fillerCount: page.filler.length,
          ...(warning.alignment ? { alignment: warning.alignment } : {}),
        };
      }

      entries.push({ slug, title, anilistId: forcedId, filler: page.filler });
      log(`  -> AniList ${forcedId} (override)`);
      // Deliberately NO mapping.json entry. overrides.json is read first on
      // every run, so a cache entry could never resolve a live pin - it could
      // only survive one, and keep publishing a forced id after its line was
      // deleted. Not writing it is what makes un-pinning a one-line deletion.
      continue;
    }

    // 2. Cached mapping, so repeat runs do not re-query AniList — but only
    //    when the entry can still be audited under today's rules. See
    //    `cacheReuseBlocker`: anything weaker falls through to a fresh resolve
    //    below, because the cron runs without --refresh and a cache hit that
    //    cannot be re-judged is a decision no later run ever revisits.
    const cached = mapping[slug];
    if (cached?.anilistId && !refresh) {
      // The id is validated FIRST, and before the reuse decision, on purpose. A
      // value that is not an AniList id is not a weak match, it is a corrupt
      // file — a bad hand-edit or a merge conflict — and silently re-resolving
      // past it would throw away the only signal a human gets. mapping.json is
      // committed and hand-editable, so its ids get exactly the same scrutiny
      // as overrides.json rather than being trusted because we wrote them.
      // Without this a corrupted entry like `"anilistId": true` becomes the
      // literal filler.json key "true", which no consumer can look up and which
      // the entry-count regression guard cannot see, because the count is
      // unchanged.
      const cachedId = parseAniListId(cached.anilistId);
      if (cachedId === null) {
        log(`  invalid cached anilistId ${JSON.stringify(cached.anilistId)}; expected a positive integer`);
        unmatched[slug] = {
          title,
          reason: 'invalid-cached-mapping',
          note: 'mapping.json holds a value that is not an AniList id; re-run with --refresh or set an override',
          value: cached.anilistId ?? null,
        };
        continue;
      }

      const blocker = cacheReuseBlocker(cached);
      if (blocker) {
        log(`  re-resolving cached match: ${blocker}`);
      } else {
        // Re-run the overflow guard against the episode count recorded when the
        // mapping was made. A show the site has since extended can grow past
        // the matched entry, and the cached path would otherwise republish
        // misaligned numbers forever. (An entry whose recorded count cannot be
        // compared at all never reaches here — that is the blocker above, not
        // a check this one can make.)
        const alignment = checkEpisodeAlignment(
          page.episodeCount,
          { episodes: cached.anilistEpisodes },
          tolerance,
        );
        if (!alignment.ok) {
          log(`  unmatched: episode-count-overflow (stale cached mapping)`);
          unmatched[slug] = {
            title,
            reason: 'episode-count-overflow',
            note: 'cached mapping in mapping.json no longer covers the scraped episode range; re-run with --refresh or set an override',
            aflEpisodes: page.episodeCount,
            fillerCount: page.filler.length,
            alignment,
            anilistId: cachedId,
          };
          continue;
        }
        entries.push({ slug, title, anilistId: cachedId, filler: page.filler });
        log(`  -> AniList ${cachedId} (cached)`);
        continue;
      }
    }

    // 3. Resolve via AniList search.
    let candidates = [];
    try {
      const queries = [title];
      const paren = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title);
      if (paren) queries.push(paren[1], paren[2]);
      const seen = new Map();
      for (const q of queries) {
        for (const media of (await searchAniList(q)) ?? []) {
          if (!seen.has(media.id)) seen.set(media.id, media);
        }
        // Stop early once a plain search already produced an exact hit set.
        if (seen.size > 0 && queries.indexOf(q) === 0) {
          const early = pickMatch({ title, episodeCount: page.episodeCount, candidates: [...seen.values()], tolerance });
          if (early.matched) break;
        }
      }
      candidates = [...seen.values()];
    } catch (err) {
      log(`  anilist lookup failed: ${err.message}`);
      unmatched[slug] = { title, reason: 'anilist-error', error: String(err.message) };
      // A one-off GraphQL failure is that show's problem. A 429/5xx is the
      // whole run's problem: the client has already exhausted its own
      // Retry-After-honouring retries, so continuing would walk the remaining
      // few hundred shows re-provoking the same refusal and then publish a
      // filler.json missing almost everything. Abort; nothing is written.
      if (isRefusal(err)) {
        log('aborting run: AniList is rate-limiting or erroring. Partial results are not written.');
        throw err;
      }
      continue;
    }

    const result = pickMatch({ title, episodeCount: page.episodeCount, candidates, tolerance });

    if (!result.matched) {
      log(`  unmatched: ${result.reason}`);
      unmatched[slug] = {
        title,
        reason: result.reason,
        aflEpisodes: page.episodeCount,
        fillerCount: page.filler.length,
        ...(result.alignment ? { alignment: result.alignment } : {}),
        candidates: result.candidates,
      };
      continue;
    }

    entries.push({ slug, title, anilistId: result.anilistId, filler: page.filler });
    mapping[slug] = {
      anilistId: result.anilistId,
      title,
      matchedTitle: result.media.title?.english || result.media.title?.romaji || null,
      matchedField: result.matchedField ?? null,
      source: 'anilist-search',
      aflEpisodes: page.episodeCount,
      anilistEpisodes: result.media.episodes ?? null,
      resolvedAt: new Date().toISOString(),
    };
    log(`  -> AniList ${result.anilistId} (${mapping[slug].matchedTitle})`);
  }

  const { filler, conflicts } = buildFillerOutput(entries);

  for (const conflict of conflicts) {
    unmatched[conflict.slug] = {
      title: entries.find((e) => e.slug === conflict.slug)?.title ?? null,
      reason: 'duplicate-anilist-id',
      anilistId: conflict.anilistId,
      conflictsWith: conflict.conflictsWith,
    };
    log(`conflict: ${conflict.slug} and ${conflict.conflictsWith} both resolved to AniList ${conflict.anilistId}`);
  }

  // Repeat the override warnings at the very end. The per-show shout is
  // hundreds of lines up by the time a 65-minute run finishes, and the last
  // screen of the log is the part anyone actually reads.
  // (After the conflict pass, so a pin that lost a duplicate-id fight - and so
  // was not published after all - is not listed here.)
  const publishedAnyway = Object.entries(unmatched).filter(([, v]) => v.published);
  if (publishedAnyway.length > 0) {
    shout(
      `${publishedAnyway.length} pinned show(s) in overrides.json were PUBLISHED WITHOUT A CLEAN CHECK`,
      publishedAnyway.map(([slug, v]) => `${slug} -> AniList ${v.anilistId}: ${v.reason}`),
    );
  }

  const sortedMapping = {};
  for (const key of Object.keys(mapping).sort()) sortedMapping[key] = mapping[key];
  const sortedUnmatched = {};
  for (const key of Object.keys(unmatched).sort()) sortedUnmatched[key] = unmatched[key];

  if (!options.dryRun) {
    await writeJson(fillerFile, filler);
    await writeJson(mappingFile, sortedMapping);
    await writeJson(unmatchedFile, sortedUnmatched);
  }

  log(
    `done: ${Object.keys(filler).length} shows with filler, ` +
      `${Object.keys(sortedUnmatched).length} unmatched, ${warnings.length} warnings`,
  );

  return { filler, mapping: sortedMapping, unmatched: sortedUnmatched, warnings, entries };
}

/**
 * Every flag `main()` understands.
 *
 * This exists because `parseArgs` happily collects ANY `--flag` while `run()`
 * is called with an explicit key list, so an unrecognised flag used to be
 * silently discarded. That is harmless for most typos and actively dangerous
 * for one: `--dryrun` instead of `--dry-run` parsed fine, was dropped, and the
 * run then WROTE filler.json / mapping.json / unmatched.json while the
 * operator believed nothing had been written.
 */
export const KNOWN_FLAGS = Object.freeze([
  'help',
  'only',
  'limit',
  'crawl-delay',
  'anilist-interval',
  'refresh',
  'out',
  'dry-run',
]);

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  // Checked before --help, and before anything is fetched or written, so a
  // typo can never reach the site, AniList, or the output files.
  const known = new Set(KNOWN_FLAGS);
  const unknown = Object.keys(args).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const err = new Error(
      `unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => `--${n}`).join(', ')}\n` +
        `known flags: ${KNOWN_FLAGS.map((n) => `--${n}`).join(', ')}\n` +
        'Nothing was fetched and nothing was written. Run with --help for usage.',
    );
    // A stack trace is noise for a typo; the CLI prints the message alone.
    err.usage = true;
    throw err;
  }

  if (args.help) {
    console.log(`Usage: node scrape.js [options]

  --only <slugs>        Comma-separated slugs to scrape (smoke testing)
  --limit <n>           Only process the first n shows from the index
  --crawl-delay <ms>    Delay between site requests (floor: 10000, robots.txt)
  --anilist-interval <ms>  Delay between AniList requests (default 2000)
  --refresh             Re-query AniList even for slugs already in mapping.json
  --out <dir>           Output directory (default: cwd)
  --dry-run             Do everything except write the JSON files
`);
    return;
  }

  // A typo'd numeric flag must not silently disable a limit: `--limit abc`
  // would otherwise crawl the whole site and `--anilist-interval abc` would
  // remove the AniList throttle entirely (NaN compares false everywhere).
  const positiveNumber = (name, value, fallback) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--${name} expects a positive number, got ${JSON.stringify(value)}`);
    }
    return n;
  };

  // Note: no argv key is ever forwarded to run()'s `fetchPage` /
  // `searchAniList` seams, and run() rejects anything that is not a function,
  // so the CLI has no path to a fetcher that ignores the crawl delay.
  await run({
    outDir: args.out ? path.resolve(String(args.out)) : process.cwd(),
    only: args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null,
    limit: positiveNumber('limit', args.limit, Infinity),
    crawlDelayMs: positiveNumber('crawl-delay', args['crawl-delay'], DEFAULT_CRAWL_DELAY_MS),
    anilistIntervalMs: positiveNumber('anilist-interval', args['anilist-interval'], DEFAULT_ANILIST_INTERVAL_MS),
    refresh: Boolean(args.refresh),
    dryRun: Boolean(args['dry-run']),
  });
}
