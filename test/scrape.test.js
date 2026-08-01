/**
 * Orchestrator tests.
 *
 * `run()` owns every mapping-safety decision — override-wins, null-override
 * exclusion, invalid-override rejection, the pinned-id check, cached-mapping
 * reuse, the re-check of a cached mapping against its recorded episode count,
 * the re-test of a cached synonym-only match, the conflict path and the abort
 * paths — and a mistake in any of them republishes wrong filler numbers to a
 * shipped app. So they are driven here end to end, through the real file I/O,
 * using the `fetchPage` / `searchAniList` / `lookupAniList` seams.
 *
 * Nothing here touches the network and nothing waits: the seams take the place
 * of the rate-limited clients entirely. That is deliberately NOT a way to
 * crawl the real site faster — see the crawl-delay tests at the bottom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BASE_URL, KNOWN_FLAGS, cacheReuseBlocker, createSiteFetcher, main, run } from '../src/scrape.js';
import { DEFAULT_CRAWL_DELAY_MS } from '../src/http.js';

// --- fixtures -------------------------------------------------------------

/** Minimal /shows index markup. */
const indexPage = (shows) =>
  `<html><body><div id="ShowList"><div class="Group"><ul>${shows
    .map((s) => `<li><a href="/shows/${s.slug}">${s.title}</a></li>`)
    .join('')}</ul></div></div></body></html>`;

/**
 * Minimal show-page markup. `categories` maps a site category class to the
 * Quick List range string the site would print for it.
 */
const showPage = (title, categories) =>
  `<html><body><h1>${title} Filler List</h1><div id="Condensed">${Object.entries(categories)
    .map(
      ([category, episodes]) =>
        `<div class="${category}"><span class="Label">Episodes:</span><span class="Episodes">${episodes}</span></div>`,
    )
    .join('')}</div></body></html>`;

/** An AniList-shaped media object. */
const media = (id, { romaji = null, english = null, synonyms = [], format = 'TV', episodes = null } = {}) => ({
  id,
  title: { romaji, english, native: null },
  synonyms,
  format,
  episodes,
  seasonYear: null,
});

/**
 * Build the three seams over a plain description of the world.
 *
 * `pages` maps a slug to its HTML; `search` maps a query string to the media
 * list AniList would return; `byId` maps an AniList id to the entry a
 * by-id lookup returns (absent = AniList has no such entry). All three record
 * their calls so a test can assert that a path did NOT hit the network.
 */
function world({ shows = [], pages = {}, search = {}, byId = {} } = {}) {
  const calls = { fetched: [], searched: [], lookedUp: [] };

  const fetchPage = async (url) => {
    calls.fetched.push(url);
    if (url === `${BASE_URL}/shows`) return indexPage(shows);
    const slug = url.slice(`${BASE_URL}/shows/`.length);
    if (Object.hasOwn(pages, slug)) return pages[slug];
    const err = new Error(`HTTP 404 for ${url}`);
    err.status = 404;
    throw err;
  };

  const searchAniList = async (query) => {
    calls.searched.push(query);
    if (typeof search === 'function') return search(query);
    return search[query] ?? [];
  };

  const lookupAniList = async (id) => {
    calls.lookedUp.push(id);
    if (typeof byId === 'function') return byId(id);
    return byId[id] ?? null;
  };

  return { fetchPage, searchAniList, lookupAniList, calls };
}

/** A scratch output directory, seeded with the given JSON files. */
async function workspace(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'filler-scrape-test-'));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  return dir;
}

const readJson = async (dir, name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));

/** Run against a scratch dir, always cleaning it up. */
async function withWorkspace(files, fn) {
  const dir = await workspace(files);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const silent = () => {};

// --- overrides ------------------------------------------------------------

test('an override wins over an automatic match', async () => {
  await withWorkspace({ 'overrides.json': { naruto: 12345 } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26, 97' }) },
      // AniList would have answered with the real id; the override must win.
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
      byId: { 12345: media(12345, { english: 'Naruto', episodes: 220 }) },
    });
    const logged = [];

    const result = await run({ outDir: dir, log: (m) => logged.push(String(m)), ...w });

    assert.deepEqual(Object.keys(result.filler), ['12345'], 'the override id is the emitted key');
    assert.deepEqual(result.filler['12345'], [26, 97]);
    assert.ok(!('20' in result.filler), 'the automatic match must not also be emitted');
    assert.equal(w.calls.searched.length, 0, 'an overridden slug must not cost an AniList search');
    assert.deepEqual(await readJson(dir, 'filler.json'), result.filler);
    // A pin that checks out is silent: nothing reported, nothing shouted, and
    // nothing cached - the pin itself is the only record of the decision.
    assert.deepEqual(result.unmatched, {});
    assert.ok(!('naruto' in result.mapping), 'a pinned show must not be written to the cache');
    assert.equal(
      logged.filter((line) => line.startsWith('::warning::')).length,
      0,
      'a clean pin must not cry wolf',
    );
  });
});

test('a null override excludes the show entirely', async () => {
  await withWorkspace({ 'overrides.json': { naruto: null } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26, 97' }) },
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(Object.keys(result.filler), [], 'an excluded show emits nothing at all');
    assert.equal(result.unmatched.naruto.reason, 'excluded-by-override');
    assert.ok(!('naruto' in result.mapping), 'an excluded slug must not be cached as a mapping');
    assert.equal(w.calls.searched.length, 0);
    assert.deepEqual(await readJson(dir, 'filler.json'), {});
  });
});

test('a malformed override is rejected loudly instead of silently ignored', async () => {
  // Every one of these is a plausible hand-edit typo, and every one is
  // representable in JSON so it can really appear in overrides.json. None may
  // reach output, and none may fall through to the automatic match as if unset
  // - a typo that silently re-enabled matching would look like the override
  // "worked".
  //
  // `true` and `['20']` are the dangerous pair: `Number(true)` is 1 and
  // `Number(['20'])` is 20, so a coercion-based check accepts both and pins
  // the show to an unrelated AniList entry.
  const bad = ['20abc', '', ' ', 0, -5, 1.5, true, false, {}, [], ['20'], 'null', '0x14', '2e1'];

  for (const value of bad) {
    await withWorkspace({ 'overrides.json': { naruto: value } }, async (dir) => {
      const w = world({
        shows: [{ slug: 'naruto', title: 'Naruto' }],
        pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26, 97' }) },
        search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
      });
      const logged = [];

      const result = await run({ outDir: dir, log: (m) => logged.push(String(m)), ...w });

      const label = JSON.stringify(value);
      assert.deepEqual(Object.keys(result.filler), [], `${label} must emit nothing`);
      assert.equal(result.unmatched.naruto.reason, 'invalid-override', `${label} must be reported`);
      assert.ok(!('naruto' in result.mapping), `${label} must not poison mapping.json`);
      assert.ok(
        logged.some((line) => line.includes('invalid override')),
        `${label} must be logged, not swallowed`,
      );
      // Loudly: the reason and the offending value both survive into the file
      // a human actually reads.
      const onDisk = await readJson(dir, 'unmatched.json');
      assert.equal(onDisk.naruto.reason, 'invalid-override');
    });
  }
});

test('an id written as a quoted string is still a usable override', async () => {
  // Rejecting typos must not become rejecting the obvious hand-edit. A JSON
  // string holding exactly an integer is unambiguous, so it is accepted.
  await withWorkspace({ 'overrides.json': { naruto: ' 20 ' } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26' }) },
      byId: { 20: media(20, { english: 'Naruto', episodes: 220 }) },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(result.filler['20'], [26]);
    assert.deepEqual(Object.keys(result.filler), ['20'], 'the key is a plain integer, never " 20 "');
    assert.deepEqual(w.calls.lookedUp, [20], 'the pin is verified against the parsed integer id');
  });
});

test('an override is never cached in mapping.json, so deleting the pin un-pins the show', async () => {
  // The whole point of a hand-maintained pin is that a human can take it back.
  // Recording it in the cache made that impossible: the next run consumed its
  // own record as an ordinary cache hit and republished the forced id forever,
  // no matter what overrides.json said afterwards.
  await withWorkspace({ 'overrides.json': { naruto: 12345 } }, async (dir) => {
    const scene = () =>
      world({
        shows: [{ slug: 'naruto', title: 'Naruto' }],
        pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
        search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
        byId: { 12345: media(12345, { english: 'Naruto', episodes: 220 }) },
      });

    const pinned = await run({ outDir: dir, log: silent, ...scene() });
    assert.deepEqual(Object.keys(pinned.filler), ['12345'], 'the pin is honoured while it exists');
    assert.ok(!('naruto' in pinned.mapping), 'a pinned show must not be written to the cache');
    assert.deepEqual(await readJson(dir, 'mapping.json'), {}, 'and nothing about it survives on disk');

    // The operator deletes the line. That must be the whole fix.
    await writeFile(path.join(dir, 'overrides.json'), '{}\n', 'utf8');

    const unpinned = await run({ outDir: dir, log: silent, ...scene() });
    assert.deepEqual(Object.keys(unpinned.filler), ['20'], 'deleting the line really does un-pin the show');
    assert.equal(unpinned.mapping.naruto.anilistId, 20);
    assert.equal(unpinned.mapping.naruto.source, 'anilist-search');
  });
});

test('a stale override-sourced mapping.json entry is dropped on read, not honoured', async () => {
  // Migration path: entries written by an earlier build. Honouring one would
  // keep a deleted pin alive, and it carries no `anilistEpisodes`, so the
  // overflow re-check would be permanently inert for that slug.
  const mapping = {
    naruto: {
      anilistId: 12345,
      title: 'Naruto',
      source: 'override',
      aflEpisodes: 220,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping, 'overrides.json': {} }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
    });
    const logged = [];

    const result = await run({ outDir: dir, log: (m) => logged.push(String(m)), ...w });

    assert.deepEqual(Object.keys(result.filler), ['20'], 'the forced id is gone; the show resolves normally');
    assert.deepEqual(w.calls.searched, ['Naruto'], 'the dropped entry is a cache miss, so AniList is asked');
    assert.equal(result.mapping.naruto.source, 'anilist-search');
    assert.equal(result.mapping.naruto.anilistEpisodes, 220, 'the replacement can be overflow-checked');
    const onDisk = await readJson(dir, 'mapping.json');
    assert.equal(onDisk.naruto.anilistId, 20, 'the stale entry is gone from disk too');
    assert.ok(
      logged.some((line) => line.includes('stale override-sourced mapping.json entry')),
      'the migration is logged, not silent',
    );
  });
});

test('a pinned id whose entry cannot hold the scrape is shouted about and published anyway', async () => {
  // A pin is an explicit decision, so the overflow guard may not veto it - but
  // a pin made in 2026 against a show that keeps airing rots silently, so the
  // check still runs and a failure has to be impossible to miss.
  await withWorkspace({ 'overrides.json': { naruto: 20 } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-480', filler: '490-492' }) },
      byId: { 20: media(20, { english: 'Naruto', episodes: 220 }) },
    });
    const logged = [];

    const result = await run({ outDir: dir, log: (m) => logged.push(String(m)), ...w });

    assert.deepEqual(w.calls.lookedUp, [20], 'the pinned id is checked against AniList');
    assert.deepEqual(result.filler['20'], [490, 491, 492], 'the operator’s intent still publishes');

    const entry = result.unmatched.naruto;
    assert.equal(entry.reason, 'override-episode-count-overflow');
    assert.equal(entry.published, true, 'it must be readable as "published anyway", not as "dropped"');
    assert.equal(entry.alignment.scrapedEpisodeCount, 492);
    assert.equal(entry.alignment.anilistEpisodes, 220);
    assert.equal(entry.alignment.overflow, 272);
    assert.deepEqual(await readJson(dir, 'unmatched.json'), result.unmatched, 'and it reaches the file on disk');

    assert.ok(
      result.warnings.some((line) => line.startsWith('naruto:') && line.includes('AniList 20')),
      `it counts towards the run’s warnings, got ${JSON.stringify(result.warnings)}`,
    );
    const annotations = logged.filter((line) => line.startsWith('::warning::'));
    assert.ok(annotations.length >= 1, 'it is emitted as a CI annotation, not a debug line');
    assert.ok(
      annotations.some((line) => line.includes('naruto')),
      `the shouted line must name the slug, got ${JSON.stringify(annotations)}`,
    );
    assert.ok(
      logged.some((line) => line.includes('*'.repeat(78))),
      'and it is banner-wrapped so it survives a 65-minute log',
    );
  });
});

test('a pinned id that AniList does not have is shouted about and published anyway', async () => {
  // The typo that stays well-formed: 1535 fat-fingered to 15355. Every id
  // check in the codebase passes it, and it publishes a key nothing can look
  // up. It still publishes - a pin is a decision - but never quietly.
  await withWorkspace({ 'overrides.json': { naruto: 15355 } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
      byId: {}, // AniList has no such entry
    });
    const logged = [];

    const result = await run({ outDir: dir, log: (m) => logged.push(String(m)), ...w });

    assert.deepEqual(result.filler['15355'], [26]);
    assert.equal(result.unmatched.naruto.reason, 'override-anilist-id-not-found');
    assert.equal(result.unmatched.naruto.published, true);
    assert.ok(logged.some((line) => line.startsWith('::warning::') && line.includes('15355')));
  });
});

test('a failed lookup for a pinned id is reported, and a refusal still aborts the run', async () => {
  await withWorkspace({ 'overrides.json': { naruto: 20 } }, async (dir) => {
    const base = {
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
    };

    // A one-off failure is that show's problem: publish, but say so.
    const flaky = world({
      ...base,
      byId: () => {
        throw new Error('AniList error: Validation error');
      },
    });
    const result = await run({ outDir: dir, log: silent, ...flaky });
    assert.deepEqual(result.filler['20'], [26], 'a broken check does not drop a pinned show');
    assert.equal(result.unmatched.naruto.reason, 'override-check-failed');
    assert.equal(result.unmatched.naruto.published, true);

    // A refusal is the run's problem, exactly like every other AniList call.
    const refused = world({
      ...base,
      byId: () => {
        const err = new Error('AniList error: Too Many Requests');
        err.status = 429;
        throw err;
      },
    });
    await assert.rejects(
      () => run({ outDir: dir, log: silent, ...refused }),
      (err) => err.status === 429,
    );
  });
});

// --- cached mappings ------------------------------------------------------

test('a cached mapping is reused without re-querying AniList', async () => {
  const mapping = {
    naruto: {
      anilistId: 20,
      title: 'Naruto',
      matchedField: 'english',
      source: 'anilist-search',
      aflEpisodes: 220,
      anilistEpisodes: 220,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26, 97, 101-103' }) },
      search: () => assert.fail('a cached slug must not reach AniList'),
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.equal(w.calls.searched.length, 0, 'zero AniList queries for a cached slug');
    assert.deepEqual(result.filler['20'], [26, 97, 101, 102, 103]);
    assert.equal(result.mapping.naruto.resolvedAt, '2026-01-01T00:00:00.000Z', 'the cache entry is left intact');
  });
});

test('--refresh re-queries AniList for a slug that is already cached', async () => {
  const mapping = { naruto: { anilistId: 999, title: 'Naruto', anilistEpisodes: 220 } };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
    });

    const result = await run({ outDir: dir, log: silent, refresh: true, ...w });

    assert.deepEqual(w.calls.searched, ['Naruto']);
    assert.deepEqual(Object.keys(result.filler), ['20'], 'the refreshed id replaces the stale cached one');
  });
});

test('a cached mapping whose recorded episode count no longer covers the scrape is refused', async () => {
  // The real hole this closes: the show was mapped when the site listed 220
  // episodes, AniList's entry holds 220, and the site has since grown to 500
  // because the series continued under the same slug. The cached path would
  // otherwise republish absolute episode numbers 221-500 against an entry that
  // stops at 220 - every one of them landing on the wrong episode.
  const mapping = {
    naruto: {
      anilistId: 20,
      title: 'Naruto',
      matchedField: 'english',
      source: 'anilist-search',
      aflEpisodes: 220,
      anilistEpisodes: 220,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-480', filler: '26, 97, 490-500' }) },
      search: () => assert.fail('the cached path must not silently fall through to a fresh query'),
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(Object.keys(result.filler), [], 'nothing is emitted for the overflowing show');
    const entry = (await readJson(dir, 'unmatched.json')).naruto;
    assert.equal(entry.reason, 'episode-count-overflow');
    assert.equal(entry.anilistId, 20, 'the id it would have used is reported for review');
    assert.equal(entry.alignment.anilistEpisodes, 220);
    assert.equal(entry.alignment.scrapedEpisodeCount, 500);
    assert.equal(entry.alignment.overflow, 280);
  });
});

test('a cached mapping with an unknown recorded episode count is re-resolved, not trusted', async () => {
  // The hole this closes, and it is the loudest kind of quiet: an entry whose
  // recorded `anilistEpisodes` is null can never fail the overflow guard,
  // because `checkEpisodeAlignment(240, { episodes: null })` answers `unknown`,
  // and `unknown` is `ok`. So the guard was permanently inert for every show
  // mapped while it was still airing - exactly the long-running shows that
  // carry the most filler.
  //
  // Here the entry was recorded at 120 site episodes with a null count. AniList
  // has since finalised it at 120 and split the continuation into a separate
  // entry, while the site kept numbering absolutely and now runs to 240. The
  // cached path used to republish filler 201-240 against a 120-episode entry
  // with zero AniList queries, zero warnings and nothing in unmatched.json -
  // and the weekly cron never passes --refresh, so it never self-healed.
  const mapping = {
    'long-runner': {
      anilistId: 12345,
      title: 'Long Runner',
      matchedField: 'romaji',
      source: 'anilist-search',
      aflEpisodes: 120,
      anilistEpisodes: null,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'long-runner', title: 'Long Runner' }],
      pages: { 'long-runner': showPage('Long Runner', { manga_canon: '1-200', filler: '201-240' }) },
      search: { 'Long Runner': [media(12345, { romaji: 'Long Runner', format: 'TV', episodes: 120 })] },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(w.calls.searched, ['Long Runner'], 'an uncheckable cache entry must be re-resolved');
    assert.deepEqual(Object.keys(result.filler), [], 'nothing is published against the outgrown entry');
    const entry = (await readJson(dir, 'unmatched.json'))['long-runner'];
    assert.equal(entry.reason, 'episode-count-overflow');
    assert.equal(entry.alignment.anilistEpisodes, 120);
    assert.equal(entry.alignment.scrapedEpisodeCount, 240);
    assert.equal(entry.alignment.overflow, 120);
  });
});

test('a still-airing cached show re-resolves every run and still publishes while it fits', async () => {
  // The cost this fix accepts, stated as a test. A show AniList still lists
  // with a null episode count can never become a strong cache entry, so it is
  // re-resolved every single run. That is correct: it is precisely the show
  // that can outgrow the entry it was matched to. It must keep publishing
  // while today's evidence still holds.
  const mapping = {
    'airing-show': {
      anilistId: 300,
      title: 'Airing Show',
      matchedField: 'romaji',
      source: 'anilist-search',
      aflEpisodes: 12,
      anilistEpisodes: null,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const scene = () =>
      world({
        shows: [{ slug: 'airing-show', title: 'Airing Show' }],
        pages: { 'airing-show': showPage('Airing Show', { manga_canon: '1-10', filler: '11, 12' }) },
        search: { 'Airing Show': [media(300, { romaji: 'Airing Show', format: 'TV', episodes: null })] },
      });

    const first = scene();
    const one = await run({ outDir: dir, log: silent, ...first });
    assert.deepEqual(first.calls.searched, ['Airing Show'], 'it costs one query');
    assert.deepEqual(one.filler['300'], [11, 12], 'and it still publishes');
    assert.equal(one.mapping['airing-show'].anilistEpisodes, null, 'still unknown, so still weak');

    // Next run reads what this one wrote. It must pay the same single query
    // again rather than settling into a silent, uncheckable cache hit.
    const second = scene();
    const two = await run({ outDir: dir, log: silent, ...second });
    assert.deepEqual(second.calls.searched, ['Airing Show'], 'and it costs exactly one query again');
    assert.deepEqual(two.filler['300'], [11, 12]);
  });
});

test('a re-resolved entry records enough to become a strong cache hit, so the cost does not recur', async () => {
  // Otherwise the fix trades a silent wrong answer for a permanent extra query
  // per show, every week, forever. Once the show is finished and AniList
  // publishes a real episode count, the fresh write has to carry both halves
  // of the reuse rule - `matchedField` and `anilistEpisodes` - or the entry
  // stays weak and re-resolves for the rest of time.
  const mapping = { 'finished-show': { anilistId: 400, title: 'Finished Show', anilistEpisodes: null } };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const shows = [{ slug: 'finished-show', title: 'Finished Show' }];
    const pages = { 'finished-show': showPage('Finished Show', { manga_canon: '1-10', filler: '11, 12' }) };

    const first = world({
      shows,
      pages,
      search: { 'Finished Show': [media(400, { romaji: 'Finished Show', format: 'TV', episodes: 12 })] },
    });
    const one = await run({ outDir: dir, log: silent, ...first });

    assert.deepEqual(first.calls.searched, ['Finished Show'], 'the weak entry costs one query');
    assert.deepEqual(one.filler['400'], [11, 12]);
    assert.equal(one.mapping['finished-show'].matchedField, 'romaji', 'provenance is recorded');
    assert.equal(one.mapping['finished-show'].anilistEpisodes, 12, 'and so is a checkable episode count');

    const second = world({
      shows,
      pages,
      search: () => assert.fail('a promoted entry must be a pure cache hit'),
    });
    const two = await run({ outDir: dir, log: silent, ...second });

    assert.equal(second.calls.searched.length, 0, 'the next run pays nothing for it');
    assert.deepEqual(two.filler['400'], [11, 12], 'and still publishes it from the cache');
  });
});

test('a cached entry whose provenance is not a romaji/english match is re-resolved', async () => {
  // ALLOWLIST, not denylist. Re-testing only `matchedField === 'synonym'`
  // trusted every entry whose provenance is absent, null or unrecognised -
  // which is what older builds wrote, i.e. the entries with the *least*
  // evidence behind them were the ones treated as strong.
  for (const matchedField of [undefined, null, 'synonym', 'native', 'title', 42]) {
    const mapping = {
      'ghost-show': { anilistId: 999, title: 'Ghost Show', matchedField, anilistEpisodes: 26 },
    };

    await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
      const w = world({
        shows: [{ slug: 'ghost-show', title: 'Ghost Show' }],
        pages: { 'ghost-show': showPage('Ghost Show', { manga_canon: '1-20', filler: '21-26' }) },
        // Today's evidence: the only exact hit is a synonym on a SPECIAL, which
        // the current rule refuses. A grandfathered id must not survive that.
        search: {
          'Ghost Show': [
            media(999, { romaji: 'Ghost Show Recap', synonyms: ['Ghost Show'], format: 'SPECIAL', episodes: 26 }),
          ],
        },
      });

      const result = await run({ outDir: dir, log: silent, ...w });
      const label = JSON.stringify(matchedField ?? null);

      assert.deepEqual(w.calls.searched, ['Ghost Show'], `matchedField ${label} must be re-resolved`);
      assert.deepEqual(Object.keys(result.filler), [], `matchedField ${label} must not be republished`);
      assert.equal(result.unmatched['ghost-show'].reason, 'synonym-only-match');
    });
  }
});

test('a recorded episode count the overflow guard cannot compare is uncheckable, exactly like null', async () => {
  // The guard only compares a positive number: 0, a negative, a quoted number
  // and a boolean all come back `unknown`, which is `ok`, just like null. Any
  // of them can arrive from a hand-edit or a merge conflict, so the reuse rule
  // asks the same question the guard asks rather than testing `== null` and
  // leaving four lookalikes trusted.
  for (const anilistEpisodes of [null, undefined, 0, -5, '220', true]) {
    const mapping = {
      'repaired-show': { anilistId: 500, title: 'Repaired Show', matchedField: 'romaji', anilistEpisodes },
    };

    await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
      const w = world({
        shows: [{ slug: 'repaired-show', title: 'Repaired Show' }],
        pages: { 'repaired-show': showPage('Repaired Show', { manga_canon: '1-10', filler: '11, 12' }) },
        search: { 'Repaired Show': [media(500, { romaji: 'Repaired Show', format: 'TV', episodes: 12 })] },
      });

      const result = await run({ outDir: dir, log: silent, ...w });
      const label = JSON.stringify(anilistEpisodes ?? null);

      assert.deepEqual(w.calls.searched, ['Repaired Show'], `anilistEpisodes ${label} must be re-resolved`);
      assert.deepEqual(result.filler['500'], [11, 12], `${label} still publishes once re-checked`);
      assert.equal(result.mapping['repaired-show'].anilistEpisodes, 12, `${label} is repaired in the cache`);
    });
  }
});

test('re-resolution is scoped to the entries that need it, not the whole cache', async () => {
  // The property that keeps the run affordable: one weak entry must not drag
  // the rest of the cache into a re-query with it. Re-searching every cached
  // show would cost ~370 AniList queries a week for nothing.
  const strong = (anilistId, title) => ({ anilistId, title, matchedField: 'romaji', anilistEpisodes: 12 });
  const mapping = {
    'strong-a': strong(101, 'Strong A'),
    'strong-b': strong(102, 'Strong B'),
    'strong-c': strong(103, 'Strong C'),
    'weak-one': { anilistId: 104, title: 'Weak One', matchedField: 'romaji', anilistEpisodes: null },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const slugs = ['strong-a', 'strong-b', 'strong-c', 'weak-one'];
    const titles = { 'strong-a': 'Strong A', 'strong-b': 'Strong B', 'strong-c': 'Strong C', 'weak-one': 'Weak One' };
    const w = world({
      shows: slugs.map((slug) => ({ slug, title: titles[slug] })),
      pages: Object.fromEntries(
        slugs.map((slug) => [slug, showPage(titles[slug], { manga_canon: '1-10', filler: '11, 12' })]),
      ),
      search: { 'Weak One': [media(104, { romaji: 'Weak One', format: 'TV', episodes: 12 })] },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(w.calls.searched, ['Weak One'], 'exactly one query, for the one entry that needed it');
    assert.deepEqual(Object.keys(result.filler), ['101', '102', '103', '104'], 'and every show still publishes');
  });
});

test('the cache-reuse rule is an allowlist: only a fully auditable entry is reusable', () => {
  // Both halves in one place. Reuse means "this entry can still be judged by
  // today's rules from what was recorded", and anything else is re-resolved.
  assert.equal(cacheReuseBlocker({ matchedField: 'romaji', anilistEpisodes: 220 }), null);
  assert.equal(cacheReuseBlocker({ matchedField: 'english', anilistEpisodes: 12 }), null);

  const reResolved = [
    undefined,
    null,
    {},
    { matchedField: 'romaji' },
    { matchedField: 'romaji', anilistEpisodes: null },
    { matchedField: 'romaji', anilistEpisodes: 0 },
    { matchedField: 'romaji', anilistEpisodes: '220' },
    { matchedField: 'romaji', anilistEpisodes: true },
    { anilistEpisodes: 220 },
    { matchedField: null, anilistEpisodes: 220 },
    { matchedField: 'synonym', anilistEpisodes: 220 },
    { matchedField: 'ROMAJI', anilistEpisodes: 220 },
    { matchedField: 42, anilistEpisodes: 220 },
  ];
  for (const cached of reResolved) {
    assert.equal(
      typeof cacheReuseBlocker(cached),
      'string',
      `${JSON.stringify(cached ?? null)} must be re-resolved, with a reason saying why`,
    );
  }
});

test('a cached mapping id that is not an AniList id is refused, not published', async () => {
  // mapping.json is committed and hand-editable, so it gets the same scrutiny
  // as overrides.json. Untrusted, `String(true)` becomes the literal
  // filler.json key "true" - junk no consumer can look up, and invisible to the
  // entry-count regression guard because the count does not change.
  const bad = [true, '0x14', -7, 1.5, '20abc', {}, ['20'], '2e1'];

  for (const value of bad) {
    await withWorkspace({ 'mapping.json': { naruto: { anilistId: value, title: 'Naruto' } } }, async (dir) => {
      const w = world({
        shows: [{ slug: 'naruto', title: 'Naruto' }],
        pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26' }) },
      });

      const result = await run({ outDir: dir, log: silent, ...w });
      const label = JSON.stringify(value);

      assert.deepEqual(Object.keys(result.filler), [], `${label} must emit nothing`);
      assert.equal(result.unmatched.naruto.reason, 'invalid-cached-mapping', `${label} must be reported`);
      // Every published key must be a plain positive integer, always.
      for (const key of Object.keys(await readJson(dir, 'filler.json'))) {
        assert.match(key, /^[0-9]+$/, `${label} produced a non-numeric filler.json key`);
      }
    });
  }
});

test('a cached id written as a quoted integer is still usable and is renumbered', async () => {
  // Tightening must not reject the benign case; a JSON string holding exactly
  // an integer is unambiguous, and it must be emitted as a numeric key.
  const entry = { anilistId: '20', title: 'Naruto', matchedField: 'english', anilistEpisodes: 220 };
  await withWorkspace({ 'mapping.json': { naruto: entry } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26' }) },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(result.filler['20'], [26]);
    assert.equal(w.calls.searched.length, 0, 'a usable cached id must not cost an AniList query');
  });
});

test('a cached synonym-only match is re-tested against the current synonym rule, not trusted', async () => {
  // The rule that a synonym-only hit needs corroboration is worthless if it
  // only ever runs on first resolve: the cron runs without --refresh, so a
  // match made by an older, laxer build would be grandfathered in forever.
  // `matchedField` is recorded for exactly this reason, so read it.
  const mapping = {
    'ghost-show': {
      anilistId: 999,
      title: 'Ghost Show',
      matchedTitle: 'Ghost Show Recap',
      matchedField: 'synonym',
      source: 'anilist-search',
      aflEpisodes: 26,
      anilistEpisodes: 26,
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'ghost-show', title: 'Ghost Show' }],
      pages: { 'ghost-show': showPage('Ghost Show', { manga_canon: '1-20', filler: '21-26' }) },
      // Today's evidence: the only exact hit is a synonym on a SPECIAL, which
      // the current rule refuses. The cached id must not survive that.
      search: {
        'Ghost Show': [
          media(999, { romaji: 'Ghost Show Recap', synonyms: ['Ghost Show'], format: 'SPECIAL', episodes: 26 }),
        ],
      },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(w.calls.searched, ['Ghost Show'], 'a synonym-only cache entry must be re-resolved');
    assert.deepEqual(Object.keys(result.filler), [], 'the grandfathered id is not republished');
    assert.equal(result.unmatched['ghost-show'].reason, 'synonym-only-match');
  });
});

test('a cached synonym-only match that still passes the current rule is republished', async () => {
  // The re-test is a re-test, not a blanket drop: evidence that still clears
  // today's bar keeps its id.
  const mapping = {
    'ghost-show': { anilistId: 777, title: 'Ghost Show', matchedField: 'synonym', anilistEpisodes: 26 },
  };

  await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
    const w = world({
      shows: [{ slug: 'ghost-show', title: 'Ghost Show' }],
      pages: { 'ghost-show': showPage('Ghost Show', { manga_canon: '1-20', filler: '21-26' }) },
      search: {
        'Ghost Show': [
          media(777, { romaji: 'Betsu No Namae', synonyms: ['Ghost Show'], format: 'TV', episodes: 26 }),
        ],
      },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(result.filler['777'], [21, 22, 23, 24, 25, 26]);
    assert.equal(result.mapping['ghost-show'].matchedField, 'synonym', 'still tagged, so still re-tested next run');
  });
});

test('a cached romaji or english match with a real episode count is still served from the cache', async () => {
  // The property that keeps a weekly run cheap, and the reason the rule is a
  // rule and not "re-resolve everything": an entry that can still be judged
  // from what was recorded - AniList's own title field, and an episode count
  // the overflow guard can actually compare - costs nothing at all.
  for (const matchedField of ['romaji', 'english']) {
    const mapping = { naruto: { anilistId: 20, title: 'Naruto', matchedField, anilistEpisodes: 220 } };
    await withWorkspace({ 'mapping.json': mapping }, async (dir) => {
      const w = world({
        shows: [{ slug: 'naruto', title: 'Naruto' }],
        pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
        search: () => assert.fail(`matchedField ${matchedField} must stay a cache hit`),
      });

      const result = await run({ outDir: dir, log: silent, ...w });

      assert.deepEqual(result.filler['20'], [26]);
      assert.equal(w.calls.searched.length, 0);
    });
  }
});

// --- automatic matching ---------------------------------------------------

test('a show with no filler is omitted from filler.json entirely', async () => {
  await withWorkspace({}, async (dir) => {
    const w = world({
      shows: [
        { slug: 'death-note', title: 'Death Note' },
        { slug: 'naruto', title: 'Naruto' },
      ],
      pages: {
        // Death Note is entirely manga canon: no filler row at all.
        'death-note': showPage('Death Note', { manga_canon: '1-37' }),
        naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }),
      },
      search: {
        'Death Note': [media(1535, { english: 'Death Note', episodes: 37 })],
        Naruto: [media(20, { english: 'Naruto', episodes: 220 })],
      },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    const onDisk = await readJson(dir, 'filler.json');
    assert.deepEqual(Object.keys(onDisk), ['20'], 'only the show that has filler is emitted');
    assert.ok(!('1535' in onDisk), 'a zero-filler show must not appear at all');
    assert.equal(JSON.stringify(onDisk).includes('[]'), false, 'never emit an empty array');
    // It still resolved fine, so it is a mapping, not an unmatched failure.
    assert.equal(result.mapping['death-note'].anilistId, 1535);
    assert.ok(!('death-note' in result.unmatched));
  });
});

test('two shows resolving to one AniList id are reported, never merged', async () => {
  await withWorkspace({ 'overrides.json': { 'show-a': 20, 'show-b': 20 } }, async (dir) => {
    const w = world({
      shows: [
        { slug: 'show-a', title: 'Show A' },
        { slug: 'show-b', title: 'Show B' },
      ],
      pages: {
        'show-a': showPage('Show A', { manga_canon: '1-10', filler: '11, 12' }),
        'show-b': showPage('Show B', { manga_canon: '1-10', filler: '50' }),
      },
      byId: { 20: media(20, { english: 'Shared', episodes: 220 }) },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.deepEqual(result.filler['20'], [11, 12], 'the first claim wins, unmerged');
    assert.equal(result.unmatched['show-b'].reason, 'duplicate-anilist-id');
    assert.equal(result.unmatched['show-b'].conflictsWith, 'show-a');
  });
});

test('an unmatchable show is reported and does not stop the run', async () => {
  await withWorkspace({}, async (dir) => {
    const w = world({
      shows: [
        { slug: 'mystery-show', title: 'Mystery Show' },
        { slug: 'naruto', title: 'Naruto' },
      ],
      pages: {
        'mystery-show': showPage('Mystery Show', { manga_canon: '1-10', filler: '11' }),
        naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }),
      },
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.equal(result.unmatched['mystery-show'].reason, 'no-candidates');
    assert.deepEqual(Object.keys(result.filler), ['20'], 'the rest of the run still publishes');
  });
});

// --- abort paths ----------------------------------------------------------

test('an AniList 429 aborts the run cleanly instead of hot-looping the rest of the index', async () => {
  await withWorkspace({}, async (dir) => {
    const slugs = ['show-a', 'show-b', 'show-c'];
    const w = world({
      shows: slugs.map((slug) => ({ slug, title: slug })),
      pages: Object.fromEntries(slugs.map((slug) => [slug, showPage(slug, { manga_canon: '1-10', filler: '11' })])),
      search: () => {
        const err = new Error('AniList error: Too Many Requests');
        err.status = 429;
        throw err;
      },
    });

    await assert.rejects(
      () => run({ outDir: dir, log: silent, ...w }),
      (err) => err.status === 429,
    );

    assert.equal(w.calls.searched.length, 1, 'it must stop at the first refusal, not walk the whole index');
    assert.equal(existsSync(path.join(dir, 'filler.json')), false, 'a partial run must publish nothing');
    assert.equal(existsSync(path.join(dir, 'unmatched.json')), false);
  });
});

test('a site 429 aborts the run and writes nothing', async () => {
  await withWorkspace({}, async (dir) => {
    const w = world({ shows: [{ slug: 'show-a', title: 'Show A' }] });
    // The page fetch itself is refused.
    const fetchPage = async (url) => {
      if (url === `${BASE_URL}/shows`) return w.fetchPage(url);
      const err = new Error(`HTTP 429 for ${url}`);
      err.status = 429;
      throw err;
    };

    await assert.rejects(
      () => run({ outDir: dir, log: silent, fetchPage, searchAniList: w.searchAniList }),
      (err) => err.status === 429,
    );
    assert.equal(existsSync(path.join(dir, 'filler.json')), false);
  });
});

test('a single 404 is that show’s problem, not the run’s', async () => {
  await withWorkspace({}, async (dir) => {
    const w = world({
      shows: [
        { slug: 'gone', title: 'Gone' },
        { slug: 'naruto', title: 'Naruto' },
      ],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }) },
      search: { Naruto: [media(20, { english: 'Naruto', episodes: 220 })] },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.equal(result.unmatched.gone.reason, 'fetch-failed');
    assert.deepEqual(Object.keys(result.filler), ['20']);
  });
});

test('a non-rate-limit AniList failure is that show’s problem, not the run’s', async () => {
  await withWorkspace({}, async (dir) => {
    const w = world({
      shows: [
        { slug: 'broken', title: 'Broken' },
        { slug: 'naruto', title: 'Naruto' },
      ],
      pages: {
        broken: showPage('Broken', { manga_canon: '1-10', filler: '11' }),
        naruto: showPage('Naruto', { manga_canon: '1-219', filler: '26' }),
      },
      search: (query) => {
        if (query === 'Broken') throw new Error('AniList error: Validation error');
        return [media(20, { english: 'Naruto', episodes: 220 })];
      },
    });

    const result = await run({ outDir: dir, log: silent, ...w });

    assert.equal(result.unmatched.broken.reason, 'anilist-error');
    assert.deepEqual(Object.keys(result.filler), ['20'], 'the run continues past a one-off error');
  });
});

// --- output shape ---------------------------------------------------------

test('the published shape is string keys mapped to ascending deduped integer arrays', async () => {
  await withWorkspace({ 'overrides.json': { 'show-a': 20, 'show-b': 5 } }, async (dir) => {
    const w = world({
      shows: [
        { slug: 'show-a', title: 'Show A' },
        { slug: 'show-b', title: 'Show B' },
      ],
      pages: {
        // Overlapping and out-of-order ranges, exactly as a hand-edited quick
        // list can print them.
        'show-a': showPage('Show A', { manga_canon: '1-25', filler: '97, 26, 101-103, 102' }),
        'show-b': showPage('Show B', { manga_canon: '1-10', filler: '3, 1, 2' }),
      },
      byId: {
        20: media(20, { english: 'Show A', episodes: 220 }),
        5: media(5, { english: 'Show B', episodes: 12 }),
      },
    });

    await run({ outDir: dir, log: silent, ...w });
    const filler = JSON.parse(await readFile(path.join(dir, 'filler.json'), 'utf8'));

    assert.deepEqual(Object.keys(filler), ['5', '20'], 'keys are ascending numeric ids, as strings');
    for (const key of Object.keys(filler)) {
      assert.equal(typeof key, 'string');
      assert.match(key, /^[0-9]+$/);
    }
    assert.deepEqual(filler['20'], [26, 97, 101, 102, 103], 'deduped and ascending');
    assert.deepEqual(filler['5'], [1, 2, 3]);
    for (const episodes of Object.values(filler)) {
      assert.ok(Array.isArray(episodes) && episodes.length > 0);
      assert.ok(episodes.every((n) => Number.isInteger(n) && n > 0));
      assert.deepEqual(episodes, [...episodes].sort((a, b) => a - b));
      assert.equal(new Set(episodes).size, episodes.length);
    }
  });
});

test('mixed canon/filler is not published as filler', async () => {
  // The consuming app treats a mixed episode as canon; publishing it as filler
  // would make the app skip real story.
  await withWorkspace({ 'overrides.json': { naruto: 20 } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: {
        naruto: showPage('Naruto', { manga_canon: '1-6', 'mixed_canon/filler': '7, 9, 14-16', filler: '26' }),
      },
      byId: { 20: media(20, { english: 'Naruto', episodes: 220 }) },
    });

    const result = await run({ outDir: dir, log: silent, ...w });
    assert.deepEqual(result.filler['20'], [26]);
  });
});

test('a dry run computes everything and writes nothing', async () => {
  await withWorkspace({ 'overrides.json': { naruto: 20 } }, async (dir) => {
    const w = world({
      shows: [{ slug: 'naruto', title: 'Naruto' }],
      pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26' }) },
      byId: { 20: media(20, { english: 'Naruto', episodes: 220 }) },
    });

    const result = await run({ outDir: dir, log: silent, dryRun: true, ...w });

    assert.deepEqual(result.filler['20'], [26]);
    assert.equal(existsSync(path.join(dir, 'filler.json')), false);
    assert.equal(existsSync(path.join(dir, 'mapping.json')), false);
  });
});

// --- the command line -----------------------------------------------------

/** Capture console.log for the duration of `fn`. */
async function captureStdout(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines.join('\n');
}

test('a mistyped flag is refused loudly instead of being silently discarded', async () => {
  // The nasty one is `--dryrun`. parseArgs collects any `--flag`, run() is
  // called with an explicit key list, so the typo used to be dropped on the
  // floor - and the run then WROTE all three files while the operator watched
  // what they believed was a dry run.
  await withWorkspace({}, async (dir) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('a rejected command line must never reach the network');
    try {
      const typos = [
        ['--dryrun'],
        ['--dry_run'],
        ['--dryRun'],
        ['--out', dir, '--refres'],
        ['--out', dir, '--limitt', '5'],
        ['--help', '--dryrun'],
      ];

      for (const argv of typos) {
        const bad = argv.find((token) => token.startsWith('--') && !KNOWN_FLAGS.includes(token.slice(2)));
        await assert.rejects(
          () => main(argv),
          (err) => {
            assert.match(err.message, /unknown flag/i, `${argv.join(' ')} must be refused`);
            assert.ok(err.message.includes(bad), `the message must name ${bad}, got: ${err.message}`);
            assert.ok(err.message.includes('--dry-run'), 'and must list the flags that do exist');
            return true;
          },
        );
      }

      for (const name of ['filler.json', 'mapping.json', 'unmatched.json']) {
        assert.equal(existsSync(path.join(dir, name)), false, `${name} must not have been written`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('--help still works and documents every flag main() accepts', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('--help must not reach the network');
  try {
    const help = await captureStdout(() => main(['--help']));
    for (const flag of KNOWN_FLAGS) {
      if (flag === 'help') continue;
      assert.ok(help.includes(`--${flag}`), `--${flag} is accepted but undocumented in --help`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- the seam must not be a politeness bypass -----------------------------

test('the real fetcher clamps the crawl delay up to the site minimum and cannot be talked below it', () => {
  for (const attempt of [0, -1, 1, 250, '5', null, undefined, Number.NaN, 'fast', {}]) {
    const fetcher = createSiteFetcher({ crawlDelayMs: attempt });
    assert.equal(
      fetcher.crawlDelayMs,
      DEFAULT_CRAWL_DELAY_MS,
      `crawlDelayMs ${JSON.stringify(attempt)} must clamp up to the ${DEFAULT_CRAWL_DELAY_MS}ms floor`,
    );
  }
  // Raising it is allowed; only lowering is not.
  assert.equal(createSiteFetcher({ crawlDelayMs: 30_000 }).crawlDelayMs, 30_000);
  // And the value cannot be edited afterwards to misreport the real delay.
  const fetcher = createSiteFetcher();
  assert.throws(() => {
    'use strict';
    fetcher.crawlDelayMs = 0;
  });
  assert.equal(fetcher.crawlDelayMs, DEFAULT_CRAWL_DELAY_MS);
});

test('the seam only accepts a live function, so no flag or env var can reach it', async () => {
  // A CLI flag or an environment variable is a string. If a string were
  // accepted here the seam would be a supported way to swap the polite fetcher
  // out in production; because only a callable is accepted, the only route in
  // is `import { run }`, and main() forwards no argv key to either seam.
  for (const notAFunction of ['http://localhost:8080', '', 0, 1, true, {}, [], { fetch: () => {} }]) {
    await assert.rejects(
      () => run({ outDir: os.tmpdir(), log: silent, fetchPage: notAFunction }),
      (err) => err instanceof TypeError && /must be a function/.test(err.message),
      `fetchPage=${JSON.stringify(notAFunction)} must be refused`,
    );
    await assert.rejects(
      () => run({ outDir: os.tmpdir(), log: silent, searchAniList: notAFunction }),
      (err) => err instanceof TypeError && /must be a function/.test(err.message),
      `searchAniList=${JSON.stringify(notAFunction)} must be refused`,
    );
    await assert.rejects(
      () => run({ outDir: os.tmpdir(), log: silent, lookupAniList: notAFunction }),
      (err) => err instanceof TypeError && /must be a function/.test(err.message),
      `lookupAniList=${JSON.stringify(notAFunction)} must be refused`,
    );
  }
});

test('the whole offline suite really is offline', async () => {
  // If any orchestrator path ever slipped back to the real clients, this would
  // reach the network. It must not.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('run() must not touch the network when both seams are injected');
  try {
    await withWorkspace({ 'overrides.json': { naruto: 20 } }, async (dir) => {
      const w = world({
        shows: [{ slug: 'naruto', title: 'Naruto' }],
        pages: { naruto: showPage('Naruto', { manga_canon: '1-25', filler: '26' }) },
        byId: { 20: media(20, { english: 'Naruto', episodes: 220 }) },
      });
      const result = await run({ outDir: dir, log: silent, ...w });
      assert.deepEqual(result.filler['20'], [26]);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
