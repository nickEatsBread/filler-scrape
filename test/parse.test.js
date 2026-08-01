import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CATEGORY,
  expandRanges,
  expandRangesDetailed,
  normaliseCategory,
  parseEpisodeTable,
  parseQuickList,
  parseShowIndex,
  parseShowPage,
  parseShowTitle,
} from '../src/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name), 'utf8');

/**
 * The known-good expansion for AniList id 20.
 *
 * 1 + 1 + 6 + 5 + 77 = 90 episodes. Cross-checked two independent ways
 * against the saved fixture: the arithmetic above, and the 90 rows in the
 * episode table whose category is exactly "Filler" (identical set).
 */
const NARUTO_QUICK_LIST = '26, 97, 101-106, 136-140, 143-219';
const NARUTO_FILLER_COUNT = 90;
const narutoExpected = [
  26,
  97,
  ...Array.from({ length: 6 }, (_, i) => 101 + i), // 101-106
  ...Array.from({ length: 5 }, (_, i) => 136 + i), // 136-140
  ...Array.from({ length: 77 }, (_, i) => 143 + i), // 143-219
];

test('expandRanges expands a single long range', () => {
  const result = expandRanges('143-219');
  assert.equal(result.length, 77);
  assert.equal(result[0], 143);
  assert.equal(result.at(-1), 219);
});

test('expandRanges returns a plain array with no extra own properties', () => {
  // Guards a real bug: attaching metadata to the returned array made every
  // deepEqual against a plain array fail.
  const result = expandRanges('1-3');
  assert.deepEqual(result, [1, 2, 3]);
  assert.deepEqual(Object.keys(result), ['0', '1', '2']);
});

test('expandRanges expands mixed singles and ranges, sorted and deduped', () => {
  assert.deepEqual(expandRanges('26, 97, 101-106'), [26, 97, 101, 102, 103, 104, 105, 106]);
  // Out of order input, duplicates, and a reversed range all normalise.
  assert.deepEqual(expandRanges('5, 3, 3, 10-8'), [3, 5, 8, 9, 10]);
});

test('expandRanges reproduces the known-good Naruto filler expansion', () => {
  const result = expandRanges(NARUTO_QUICK_LIST);
  assert.deepEqual(result, narutoExpected);
  assert.equal(result.length, NARUTO_FILLER_COUNT);
});

test('expandRangesDetailed tolerates junk tokens and reports them instead of throwing', () => {
  const result = expandRangesDetailed('5, ??, 8-10, unknown, 12--, , 15 to 16');
  assert.deepEqual(result.numbers, [5, 8, 9, 10, 15, 16]);
  assert.deepEqual(result.skipped, ['??', 'unknown', '12--']);
});

test('expandRanges accepts every dash the site and its editors emit', () => {
  const expected = [101, 102, 103, 104, 105, 106];
  for (const dash of ['-', '‐', '‒', '–', '—', '―', '−', '~']) {
    assert.deepEqual(expandRanges(`101${dash}106`), expected, `dash U+${dash.codePointAt(0).toString(16)} failed`);
  }
  // Non-breaking spaces around the dash, as emitted by the site's HTML.
  assert.deepEqual(expandRanges('101 - 106'), expected);
});

test('expandRanges handles empty and null input', () => {
  assert.deepEqual(expandRanges(''), []);
  assert.deepEqual(expandRanges(null), []);
});

test('expandRanges refuses an absurdly wide range rather than exhausting memory', () => {
  const result = expandRangesDetailed('1-999999');
  assert.deepEqual(result.numbers, []);
  assert.deepEqual(result.skipped, ['1-999999']);
});

test('normaliseCategory folds the class attribute and the visible label', () => {
  assert.equal(normaliseCategory('manga_canon odd'), CATEGORY.MANGA_CANON);
  assert.equal(normaliseCategory('mixed_canon/filler even'), CATEGORY.MIXED);
  assert.equal(normaliseCategory('Mixed Canon/Filler'), CATEGORY.MIXED);
  assert.equal(normaliseCategory('Anime Canon'), CATEGORY.ANIME_CANON);
  assert.equal(normaliseCategory('filler odd'), CATEGORY.FILLER);
  assert.equal(normaliseCategory('nonsense'), null);
  assert.equal(normaliseCategory(''), null);
});

test('parseShowIndex reads slugs and titles from the live index page', () => {
  const shows = parseShowIndex(fixture('shows.html'));
  // 371 in the captured snapshot, across 26 letter groups. Asserted as a floor
  // so the test does not break every time the site adds a show.
  assert.ok(shows.length >= 350, `expected 350+ shows, got ${shows.length}`);

  const naruto = shows.find((s) => s.slug === 'naruto');
  assert.deepEqual(naruto, { slug: 'naruto', title: 'Naruto' });

  // Slugs are unique and never contain a second path segment.
  assert.equal(new Set(shows.map((s) => s.slug)).size, shows.length);
  assert.ok(shows.every((s) => !s.slug.includes('/')));

  // Titles come from the anchor text: the index contains at least one entry
  // whose slug belongs to an unrelated show, so a slug-derived title is wrong.
  assert.ok(shows.every((s) => s.title.length > 0));
});

test('parseShowIndex decodes percent-encoded slugs and survives a malformed one', () => {
  const html = `<div id="ShowList"><div class="Group"><ul>
    <li><a href="/shows/sh%C5%8Dnan-pure-love-gang">A Certain Scientific Accelerator</a></li>
    <li><a href="/shows/%E5%BD%B1%zz-broken">Broken Escape</a></li>
    <li><a href="/shows/naruto/1">Naruto Episode 1</a></li>
    <li><a href="/shows/naruto">Naruto</a></li>
  </ul></div></div>`;
  const shows = parseShowIndex(html);
  assert.deepEqual(
    shows.map((s) => s.slug),
    ['shōnan-pure-love-gang', '%E5%BD%B1%zz-broken', 'naruto'],
  );
  // The slug can belong to a completely unrelated show, so the title must come
  // from the anchor text.
  assert.equal(shows[0].title, 'A Certain Scientific Accelerator');
});

test('parseQuickList reads every category from the Naruto page', () => {
  const quick = parseQuickList(fixture('naruto.html'));
  assert.ok(quick);
  assert.deepEqual(quick.byCategory[CATEGORY.FILLER], narutoExpected);
  // Mixed is parsed and kept separate; it is not folded into filler.
  assert.ok(quick.byCategory[CATEGORY.MIXED].includes(7));
  assert.ok(quick.byCategory[CATEGORY.MIXED].includes(9));
  assert.ok(quick.byCategory[CATEGORY.MANGA_CANON].includes(1));
});

test('parseEpisodeTable reads all 220 Naruto rows with their categories', () => {
  const table = parseEpisodeTable(fixture('naruto.html'));
  assert.ok(table);
  assert.equal(table.rows.length, 220);
  assert.deepEqual(table.byCategory[CATEGORY.FILLER], narutoExpected);
});

test('parseShowTitle strips the "Filler List" suffix', () => {
  assert.equal(parseShowTitle(fixture('naruto.html')), 'Naruto');
  assert.equal(parseShowTitle(fixture('death-note.html')), 'Death Note');
});

test('parseShowPage: Naruto matches the known-good expansion and agrees across sources', () => {
  const page = parseShowPage(fixture('naruto.html'));
  assert.equal(page.title, 'Naruto');
  assert.equal(page.source, 'quicklist');
  assert.equal(page.episodeCount, 220);
  assert.deepEqual(page.filler, narutoExpected);
  assert.equal(page.filler.length, NARUTO_FILLER_COUNT);
  assert.equal(page.disagreement, null, 'quick list and table should agree for Naruto');
});

test('parseShowPage: mixed canon/filler episodes are NOT treated as filler', () => {
  const page = parseShowPage(fixture('naruto.html'));
  // Verified against the data the consuming app already ships: these episodes
  // are Mixed Canon/Filler and are absent from its filler array.
  for (const episode of [7, 9, 14, 15, 16]) {
    assert.ok(!page.filler.includes(episode), `episode ${episode} is mixed, must not be filler`);
  }
  // ...while a pure filler episode either side of them is present.
  assert.ok(page.filler.includes(26));
  assert.ok(page.filler.includes(97));
});

test('parseShowPage: a show with zero filler yields an empty array', () => {
  const page = parseShowPage(fixture('death-note.html'));
  assert.equal(page.title, 'Death Note');
  assert.deepEqual(page.filler, []);
  assert.equal(page.episodeCount, 37);
  // Death Note does have mixed episodes; they must not leak into filler.
  assert.ok(page.categories[CATEGORY.MIXED].includes(1));
  assert.ok(page.categories[CATEGORY.MIXED].includes(37));
});

test('parseShowPage: malformed quick list is salvaged, junk is reported', () => {
  const page = parseShowPage(fixture('malformed-quicklist.html'));
  assert.deepEqual(page.filler, [5, 8, 10, 15, 16]);
  assert.equal(page.source, 'quicklist');
  assert.ok(
    page.warnings.some((w) => w.includes('unparseable quick-list token')),
    'junk tokens should raise a warning',
  );
  // The category whose class attribute was missing is still classified via its label.
  assert.deepEqual(page.categories[CATEGORY.MIXED], [7]);
});

test('parseShowPage: quick list vs table disagreement is reported, not hidden', () => {
  const page = parseShowPage(fixture('malformed-quicklist.html'));
  assert.ok(page.disagreement, 'expected a reported disagreement');
  // The table marks episode 9 as filler; the quick list does not list it.
  assert.deepEqual(page.disagreement.onlyInTable, [9]);
  assert.deepEqual(page.disagreement.onlyInQuickList, []);
  assert.ok(page.warnings.some((w) => w.includes('disagree')));
});

test('parseShowPage: falls back to the episode table when the quick list is missing', () => {
  const page = parseShowPage(fixture('no-quicklist.html'));
  assert.equal(page.source, 'table');
  assert.deepEqual(page.filler, [2, 4]);
  assert.equal(page.episodeCount, 4);
  assert.ok(page.warnings.some((w) => w.includes('quick list missing')));
});

test('parseShowPage: a page with neither source degrades to empty instead of throwing', () => {
  const page = parseShowPage('<html><body><h1>Nothing Filler List</h1></body></html>');
  assert.deepEqual(page.filler, []);
  assert.equal(page.source, 'none');
  assert.equal(page.episodeCount, 0);
});
