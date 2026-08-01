import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFillerOutput,
  checkEpisodeAlignment,
  mediaTitleFields,
  mediaTitles,
  normaliseTitle,
  pickMatch,
  scoreCandidate,
  titleCandidates,
} from '../src/match.js';

/** Minimal AniList-shaped media object. */
const media = (id, { romaji = null, english = null, synonyms = [], format = 'TV', episodes = null, seasonYear = null } = {}) => ({
  id,
  title: { romaji, english, native: null },
  synonyms,
  format,
  episodes,
  seasonYear,
});

const NARUTO = media(20, { romaji: 'NARUTO', english: 'Naruto', synonyms: ['ナルト'], episodes: 220, seasonYear: 2002 });
const SHIPPUDEN = media(1735, {
  romaji: 'NARUTO: Shippuuden',
  english: 'Naruto: Shippuden',
  synonyms: ['Naruto Hurricane Chronicles'],
  episodes: 500,
  seasonYear: 2007,
});

test('normaliseTitle folds case, punctuation, long vowels and ampersands', () => {
  assert.equal(normaliseTitle('NARUTO'), 'naruto');
  assert.equal(normaliseTitle('Naruto: Shippuuden'), 'naruto shippuuden');
  assert.equal(normaliseTitle('Fullmetal Alchemist: Brotherhood'), 'fullmetal alchemist brotherhood');
  assert.equal(normaliseTitle('Tenchi Muyō!'), 'tenchi muyo');
  assert.equal(normaliseTitle('Fruits Basket'), 'fruits basket');
  assert.equal(normaliseTitle('Nisekoi:'), 'nisekoi');
  assert.equal(normaliseTitle("JoJo's Bizarre Adventure"), 'jojos bizarre adventure');
  assert.equal(normaliseTitle('Chi & Co'), 'chi and co');
});

test('normaliseTitle keeps year suffixes so distinct entries cannot collide', () => {
  assert.notEqual(normaliseTitle('Fullmetal Alchemist (2009)'), normaliseTitle('Fullmetal Alchemist'));
});

test('titleCandidates splits the romaji alias out of a parenthesised index title', () => {
  assert.deepEqual(titleCandidates('A Certain Magical Index (Toaru Majutsu No Index)'), [
    'a certain magical index toaru majutsu no index',
    'a certain magical index',
    'toaru majutsu no index',
  ]);
  assert.deepEqual(titleCandidates('Naruto'), ['naruto']);
});

test('mediaTitles gathers romaji, english and synonyms without duplicates', () => {
  assert.deepEqual(mediaTitles(NARUTO), ['naruto']);
  assert.deepEqual(mediaTitles(SHIPPUDEN), ['naruto shippuuden', 'naruto shippuden', 'naruto hurricane chronicles']);
});

test('scoreCandidate marks an exact normalised title match', () => {
  const exact = scoreCandidate('Naruto', NARUTO);
  assert.equal(exact.exact, true);
  assert.equal(exact.score, 1);

  const fuzzy = scoreCandidate('Naruto', SHIPPUDEN);
  assert.equal(fuzzy.exact, false);
  assert.ok(fuzzy.score < 1);
});

// --- which field the evidence came from -----------------------------------

test('mediaTitleFields tags each title with its source field', () => {
  assert.deepEqual(mediaTitleFields(SHIPPUDEN), [
    { field: 'romaji', value: 'naruto shippuuden' },
    { field: 'english', value: 'naruto shippuden' },
    { field: 'synonym', value: 'naruto hurricane chronicles' },
  ]);
});

test('mediaTitleFields reports a string that is both a real title and a synonym as the title', () => {
  // Otherwise an entry could be downgraded to synonym-only evidence purely
  // because someone also listed its own English title in `synonyms`.
  const duplicated = media(1, { english: 'Some Show', synonyms: ['Some Show'], episodes: 12 });
  assert.deepEqual(mediaTitleFields(duplicated), [{ field: 'english', value: 'some show' }]);
});

test('scoreCandidate reports which field an exact hit landed on', () => {
  assert.equal(scoreCandidate('Naruto', NARUTO).matchedField, 'romaji');
  assert.equal(scoreCandidate('Naruto Hurricane Chronicles', SHIPPUDEN).matchedField, 'synonym');
  assert.equal(scoreCandidate('Naruto: Shippuden', SHIPPUDEN).matchedField, 'english');
});

test('scoreCandidate prefers a title-field hit over a synonym hit on the same entry', () => {
  // The parenthesised half of an index title can hit a synonym while the full
  // title hits romaji. The stronger evidence must be the one reported.
  const entry = media(7, {
    romaji: 'Real Title Alias',
    synonyms: ['Real Title'],
    episodes: 26,
  });
  const scored = scoreCandidate('Real Title (Real Title Alias)', entry);
  assert.equal(scored.exact, true);
  assert.equal(scored.matchedField, 'romaji', 'a romaji hit outranks a synonym hit regardless of variant order');
});

test('pickMatch refuses a lone synonym hit on an unrelated entry', () => {
  // The failure this closes: AniList synonyms are user-contributed, so a recap
  // or compilation entry routinely carries the parent series' name. Accepting
  // that as authoritative produces a confident, wrong id - the worst possible
  // outcome for a file that tells an app which episodes to skip.
  const recap = { id: 900, title: { romaji: null, english: 'Some Recap Special' }, synonyms: ['Gintama'], episodes: 201 };
  const result = pickMatch({ title: 'Gintama', candidates: [recap] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'synonym-only-match');
  assert.equal(result.candidates[0].matchedField, 'synonym', 'the weak evidence is reported for review');
});

test('pickMatch prefers a romaji/english match over a synonym match on another entry', () => {
  const real = media(918, { romaji: 'Gintama', episodes: 201 });
  const recap = media(900, { english: 'Some Recap Special', synonyms: ['Gintama'], format: 'SPECIAL', episodes: 201 });
  const result = pickMatch({ title: 'Gintama', episodeCount: 201, candidates: [recap, real] });
  assert.equal(result.matched, true);
  assert.equal(result.anilistId, 918);
  assert.equal(result.matchedField, 'romaji');
});

test('a title-field match wins even when the synonym entry would also fit the episode count', () => {
  // Both entries are TV with a fitting count, so the existing format and
  // episode-count tiebreaks cannot separate them. Only the field can.
  const real = media(101, { english: 'Shared Name', episodes: 50 });
  const impostor = media(102, { english: 'Something Else', synonyms: ['Shared Name'], episodes: 50 });
  const result = pickMatch({ title: 'Shared Name', episodeCount: 50, candidates: [impostor, real] });
  assert.equal(result.matched, true);
  assert.equal(result.anilistId, 101);
});

test('pickMatch still accepts a corroborated synonym-only match', () => {
  // The other direction: the correct entry genuinely carries the site's title
  // only as a synonym. It is a series format and its episode count covers the
  // scraped numbering, so there is enough evidence to act on.
  const entry = media(300, { romaji: 'Kenja no Mago', synonyms: ['Wise Mans Grandchild'], format: 'TV', episodes: 12 });
  const result = pickMatch({ title: "Wise Man's Grandchild", episodeCount: 12, candidates: [entry] });
  assert.equal(result.matched, true);
  assert.equal(result.anilistId, 300);
  assert.equal(result.matchedField, 'synonym');
});

test('a synonym-only match is refused when nothing corroborates it', () => {
  // A side entry, whatever its episode count claims. The last case has no
  // `format` at all, which is how a sparse search result arrives.
  const sideEntries = [
    media(400, { english: 'Unrelated', format: 'SPECIAL', synonyms: ['Only A Synonym'], episodes: 24 }),
    media(400, { english: 'Unrelated', format: 'OVA', synonyms: ['Only A Synonym'], episodes: 24 }),
    { id: 400, title: { english: 'Unrelated' }, synonyms: ['Only A Synonym'], episodes: 24 },
  ];
  for (const entry of sideEntries) {
    const result = pickMatch({ title: 'Only A Synonym', episodeCount: 24, candidates: [entry] });
    assert.equal(result.matched, false, `format ${entry.format} must not carry a synonym-only match`);
    assert.equal(result.reason, 'synonym-only-match');
  }
  // A series entry whose episode count cannot be checked corroborates nothing.
  const unknownCount = pickMatch({
    title: 'Only A Synonym',
    episodeCount: 24,
    candidates: [media(401, { english: 'Unrelated', format: 'TV', synonyms: ['Only A Synonym'], episodes: null })],
  });
  assert.equal(unknownCount.matched, false);
  assert.equal(unknownCount.reason, 'synonym-only-match');
});

test('a synonym-only match that overflows the scraped numbering is still refused', () => {
  const entry = media(402, { english: 'Unrelated', format: 'TV', synonyms: ['Long Series'], episodes: 26 });
  const result = pickMatch({ title: 'Long Series', episodeCount: 500, candidates: [entry] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'synonym-only-match');
});

test('two synonym-only candidates never resolve to one of them by accident', () => {
  const a = media(500, { english: 'First Unrelated', format: 'TV', synonyms: ['Contested'], episodes: 26 });
  const b = media(501, { english: 'Second Unrelated', format: 'TV', synonyms: ['Contested'], episodes: 26 });
  const result = pickMatch({ title: 'Contested', episodeCount: 26, candidates: [a, b] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'synonym-only-match');
});

// --- picking a match ------------------------------------------------------

test('pickMatch resolves Naruto to AniList id 20 and not to Shippuden', () => {
  const result = pickMatch({ title: 'Naruto', episodeCount: 220, candidates: [SHIPPUDEN, NARUTO] });
  assert.equal(result.matched, true);
  assert.equal(result.anilistId, 20);
  assert.equal(result.reason, 'exact-match');
});

test('pickMatch refuses a fuzzy-only match', () => {
  const result = pickMatch({ title: 'Naruto Shippude', episodeCount: 500, candidates: [NARUTO, SHIPPUDEN] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'no-exact-title-match');
  assert.ok(result.candidates.length > 0, 'candidates are reported for a human to review');
});

test('pickMatch refuses when the search returned nothing usable', () => {
  assert.equal(pickMatch({ title: 'Whatever', episodeCount: 12, candidates: [] }).reason, 'no-candidates');
  // A movie-only result set is not a plausible filler-list target.
  const movieOnly = pickMatch({
    title: 'Whatever',
    episodeCount: 12,
    candidates: [media(999, { english: 'Whatever', format: 'MOVIE', episodes: 1 })],
  });
  assert.equal(movieOnly.matched, false);
  assert.equal(movieOnly.reason, 'no-candidates');
});

test('pickMatch refuses an ambiguous tie between two distinct entries', () => {
  const a = media(101, { english: 'Ambiguous Show', episodes: 26 });
  const b = media(102, { romaji: 'Ambiguous Show', episodes: 26 });
  const result = pickMatch({ title: 'Ambiguous Show', episodeCount: 26, candidates: [a, b] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(result.candidates.map((c) => c.id).sort(), [101, 102]);
});

test('pickMatch breaks a tie in favour of the TV entry over a special', () => {
  const special = media(201, { english: 'Tie Show', format: 'SPECIAL', episodes: 2 });
  const tv = media(202, { english: 'Tie Show', format: 'TV', episodes: 24 });
  const result = pickMatch({ title: 'Tie Show', episodeCount: 24, candidates: [special, tv] });
  assert.equal(result.matched, true);
  assert.equal(result.anilistId, 202);
});

test('checkEpisodeAlignment catches absolute-vs-per-season numbering overflow', () => {
  // The trap: animefillerlist numbers a whole series absolutely, AniList
  // splits it into entries that restart at 1.
  const misaligned = checkEpisodeAlignment(500, NARUTO); // 500 scraped vs 220 in the entry
  assert.equal(misaligned.ok, false);
  assert.equal(misaligned.overflow, 280);

  const aligned = checkEpisodeAlignment(220, NARUTO);
  assert.equal(aligned.ok, true);

  // Fewer scraped episodes than the entry holds is fine, just incomplete data.
  assert.equal(checkEpisodeAlignment(100, NARUTO).ok, true);
});

test('checkEpisodeAlignment cannot judge a still-airing entry with a null count', () => {
  const airing = media(21, { english: 'One Piece', episodes: null });
  const result = checkEpisodeAlignment(1100, airing);
  assert.equal(result.ok, true);
  assert.equal(result.unknown, true);
  assert.equal(result.anilistEpisodes, null);
});

test('pickMatch rejects an exact title match whose episode count is too small', () => {
  // Exactly the multi-season trap: the title matches season one, but the
  // scraped numbering runs far past that entry's episode count.
  const result = pickMatch({ title: 'Naruto', episodeCount: 500, candidates: [NARUTO] });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'episode-count-overflow');
  assert.equal(result.alignment.overflow, 280);
  assert.equal(result.alignment.anilistEpisodes, 220);
});

test('buildFillerOutput keys by AniList id as a string with ascending values', () => {
  const { filler } = buildFillerOutput([
    { slug: 'naruto', anilistId: 20, filler: [26, 97, 101] },
    { slug: 'other', anilistId: 5, filler: [3, 1, 2, 2] },
  ]);
  assert.deepEqual(Object.keys(filler), ['5', '20']);
  assert.deepEqual(filler['20'], [26, 97, 101]);
  assert.deepEqual(filler['5'], [1, 2, 3], 'values are deduped and sorted ascending');
  assert.ok(Object.values(filler).every((v) => v.every(Number.isInteger)));
});

test('buildFillerOutput omits shows with no filler rather than emitting empty arrays', () => {
  const { filler } = buildFillerOutput([
    { slug: 'death-note', anilistId: 1535, filler: [] },
    { slug: 'naruto', anilistId: 20, filler: [26] },
  ]);
  assert.deepEqual(Object.keys(filler), ['20']);
  assert.ok(!('1535' in filler), 'a zero-filler show must be omitted entirely');
});

test('buildFillerOutput refuses to merge two shows onto one AniList id', () => {
  const { filler, conflicts } = buildFillerOutput([
    { slug: 'show-a', anilistId: 20, filler: [1, 2] },
    { slug: 'show-b', anilistId: 20, filler: [50] },
  ]);
  assert.deepEqual(filler['20'], [1, 2]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { slug: 'show-b', anilistId: 20, conflictsWith: 'show-a' });
});

test('the emitted shape is exactly what the consuming app reads', () => {
  const { filler } = buildFillerOutput([{ slug: 'naruto', anilistId: 20, filler: [26, 97] }]);
  const roundTripped = JSON.parse(JSON.stringify(filler));
  assert.equal(typeof Object.keys(roundTripped)[0], 'string');
  assert.ok(Array.isArray(roundTripped['20']));
  assert.equal(roundTripped['20'].every((n) => Number.isInteger(n)), true);
});
