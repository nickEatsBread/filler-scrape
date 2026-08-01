/**
 * Pure title-matching and confidence rules. No network access here; the
 * AniList client hands raw candidate media objects to `pickMatch`.
 *
 * A wrong mapping is worse than a missing one: the consuming app would label
 * the wrong episodes as filler. Everything below is biased towards refusing to
 * answer. Anything that is not an unambiguous, episode-count-consistent title
 * match is reported into unmatched.json instead of emitted into filler.json.
 */

/** Formats that can plausibly be an animefillerlist entry. */
export const ACCEPTED_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL']);

/**
 * Number of episodes an AniList entry may fall short of the scraped episode
 * count before we call the mapping misaligned. Zero by default: animefillerlist
 * numbers absolutely across a whole series, AniList splits series into
 * per-season entries restarting at 1, so any overflow at all means the numbers
 * would be applied to the wrong episodes.
 */
export const EPISODE_OVERFLOW_TOLERANCE = 0;

/**
 * AniList's own title fields for an entry, as opposed to the user-contributed
 * `synonyms` list.
 *
 * Exported because `src/scrape.js` decides whether a cached mapping may be
 * served from the cache on exactly this allowlist, and the two must not drift:
 * a field this file stopped considering strong has to stop being a strong cache
 * hit in the same commit.
 */
export const TITLE_FIELDS = Object.freeze(['romaji', 'english']);

/**
 * Is an AniList episode count a value `checkEpisodeAlignment` can actually
 * compare against?
 *
 * This is the whole of "checkable". Anything else - null on a still-airing
 * entry, an absent field, 0, a negative, a quoted number, a boolean from a
 * hand-edit - makes the overflow guard answer `unknown`, and `unknown` is `ok`.
 * Exported so the cached-mapping path can ask this exact question instead of a
 * lookalike such as `!= null`, which would leave the other four trusted.
 */
export const isKnownEpisodeCount = (value) => typeof value === 'number' && value > 0;

/**
 * Formats a synonym-only match is allowed to resolve to.
 *
 * The failure mode this guards: AniList synonyms are user-contributed and
 * routinely carry a parent series' name on a recap, compilation or special
 * entry. Those side entries are SPECIAL/OVA/MOVIE; a real long-running
 * filler-list show is a series format. See `pickMatch`.
 */
export const SYNONYM_SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

const ROMANISATION = {
  ā: 'a', â: 'a', à: 'a', á: 'a', ä: 'a', ã: 'a',
  ē: 'e', ê: 'e', è: 'e', é: 'e', ë: 'e',
  ī: 'i', î: 'i', ì: 'i', í: 'i', ï: 'i',
  ō: 'o', ô: 'o', ò: 'o', ó: 'o', ö: 'o', õ: 'o',
  ū: 'u', û: 'u', ù: 'u', ú: 'u', ü: 'u',
  ñ: 'n', ç: 'c',
  '☆': ' ', '★': ' ', '♪': ' ', '×': ' x ',
};

/**
 * Normalise a title for comparison: fold long vowels, drop punctuation,
 * expand "&", collapse whitespace. Deliberately does NOT strip parentheticals
 * or year suffixes — "Fullmetal Alchemist (2009)" must stay distinct from
 * "Fullmetal Alchemist" so the two entries cannot collide into a false tie.
 */
export function normaliseTitle(title) {
  if (!title) return '';
  let s = String(title).toLowerCase();
  s = s.replace(/[āâàáäãēêèéëīîìíïōôòóöõūûùúüñç☆★♪×]/g, (c) => ROMANISATION[c] ?? c);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['’`]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build the set of search/compare candidates for one animefillerlist title.
 *
 * Index titles frequently carry a romaji alias in parentheses, e.g.
 * "A Certain Magical Index (Toaru Majutsu No Index)". Both halves are useful:
 * the English half matches AniList's `english`, the parenthesised half often
 * matches `romaji` or a synonym.
 */
export function titleCandidates(rawTitle) {
  const candidates = [];
  const push = (value) => {
    const n = normaliseTitle(value);
    if (n && !candidates.includes(n)) candidates.push(n);
  };

  const title = String(rawTitle || '').trim();
  push(title);

  const paren = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title);
  if (paren) {
    push(paren[1]);
    push(paren[2]);
  }

  return candidates;
}

/**
 * Every comparable title on an AniList media object, normalised, each tagged
 * with the field it came from: 'romaji' | 'english' | 'synonym'.
 *
 * Order matters twice over. It is romaji, english, then synonyms, and the
 * first occurrence of a normalised string wins the dedupe — so a string that
 * is both a real title and a synonym is reported as the *title*, and a
 * synonym tag is only ever produced when a synonym is the sole source of that
 * string. `synonyms` is user-contributed data and is treated as weaker
 * evidence downstream.
 */
export function mediaTitleFields(media) {
  const raw = [
    ['romaji', media?.title?.romaji],
    ['english', media?.title?.english],
    ...(Array.isArray(media?.synonyms) ? media.synonyms : []).map((s) => ['synonym', s]),
  ];
  const out = [];
  const seen = new Set();
  for (const [field, t] of raw) {
    const value = normaliseTitle(t);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ field, value });
  }
  return out;
}

/** Every comparable title on an AniList media object, normalised. */
export function mediaTitles(media) {
  return mediaTitleFields(media).map((t) => t.value);
}

/** Sørensen-Dice coefficient over character bigrams. Used only for reporting. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const grams = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      grams.set(g, (grams.get(g) || 0) + 1);
    }
    return grams;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  let total = 0;
  for (const n of A.values()) total += n;
  for (const [g, n] of B) {
    total += n;
    overlap += Math.min(n, A.get(g) || 0);
  }
  return (2 * overlap) / total;
}

/**
 * Score one AniList media object against the animefillerlist title.
 * `exact` is the only thing that earns a mapping; `score` is for reporting.
 *
 * `matchedField` says WHICH field the hit landed on ('romaji' | 'english' |
 * 'synonym'), because those are not equally trustworthy. romaji/english are
 * AniList's own data for that entry; synonyms are user-contributed and are
 * frequently the parent series' name pasted onto a recap or special. A
 * synonym-only exact hit is therefore reported as exact but weak, and
 * `pickMatch` demands corroboration before acting on it.
 *
 * A title-field exact hit always wins over a synonym exact hit on the same
 * entry, regardless of which animefillerlist title variant produced it.
 */
export function scoreCandidate(rawTitle, media) {
  const candidates = titleCandidates(rawTitle);
  const titles = mediaTitleFields(media);

  let best = { exact: false, score: 0, matchedOn: null, matchedField: null };

  outer: for (const c of candidates) {
    for (const t of titles) {
      if (c === t.value) {
        const strong = t.field !== 'synonym';
        // Upgrade a synonym-only hit if a real title field also matches.
        if (!best.exact || (strong && best.matchedField === 'synonym')) {
          best = { exact: true, score: 1, matchedOn: t.value, matchedField: t.field };
        }
        // Nothing beats a romaji/english exact hit; stop looking.
        if (strong) break outer;
        continue;
      }
      const s = similarity(c, t.value);
      if (!best.exact && s > best.score) {
        best = { exact: false, score: s, matchedOn: t.value, matchedField: t.field };
      }
    }
  }

  return best;
}

/** Did this score land exactly on AniList's own title fields, not a synonym? */
const isTitleFieldMatch = (scored) => scored.exact === true && TITLE_FIELDS.includes(scored.matchedField);

/**
 * Is the AniList entry's episode count compatible with the absolute episode
 * numbering we scraped?
 *
 * animefillerlist numbers episodes absolutely across a whole series while
 * AniList splits the same series into per-season entries that each restart at
 * 1. So if the scraped list runs to episode 500 and the matched AniList entry
 * has 220 episodes, we matched season one of a multi-entry series and the
 * filler numbers would land on the wrong episodes.
 *
 * A null/unknown AniList episode count (still-airing shows) cannot be checked;
 * that is reported as `unknown`, not as a failure.
 */
export function checkEpisodeAlignment(scrapedEpisodeCount, media, tolerance = EPISODE_OVERFLOW_TOLERANCE) {
  const anilistEpisodes = media?.episodes;
  if (!isKnownEpisodeCount(anilistEpisodes)) {
    return { ok: true, unknown: true, anilistEpisodes: null, scrapedEpisodeCount };
  }
  if (!scrapedEpisodeCount) {
    return { ok: true, unknown: true, anilistEpisodes, scrapedEpisodeCount };
  }
  const overflow = scrapedEpisodeCount - anilistEpisodes;
  return {
    ok: overflow <= tolerance,
    unknown: false,
    overflow: overflow > 0 ? overflow : 0,
    anilistEpisodes,
    scrapedEpisodeCount,
  };
}

/**
 * Decide the mapping for one show.
 *
 * @param {object} args
 * @param {string} args.title              animefillerlist show title
 * @param {number} args.episodeCount       highest absolute episode number scraped
 * @param {object[]} args.candidates       AniList media objects from search
 * @param {number} [args.tolerance]
 * @returns {{ matched: boolean, anilistId: number|null, reason: string,
 *             media: object|null, candidates: object[] }}
 *
 * Reasons, all of which route to unmatched.json except `exact-match`:
 *   no-candidates           search returned nothing usable
 *   no-exact-title-match    best candidate was only fuzzy
 *   ambiguous               several distinct entries matched exactly
 *   episode-count-overflow  matched entry has fewer episodes than we scraped
 *   synonym-only-match      the only exact hit was on a user-contributed
 *                           synonym and nothing corroborated it
 */
export function pickMatch({ title, episodeCount, candidates, tolerance = EPISODE_OVERFLOW_TOLERANCE }) {
  const summarise = (media, scored) => ({
    id: media.id,
    title: media.title?.english || media.title?.romaji || null,
    romaji: media.title?.romaji || null,
    format: media.format || null,
    episodes: typeof media.episodes === 'number' ? media.episodes : null,
    seasonYear: media.seasonYear ?? null,
    score: Number((scored?.score ?? 0).toFixed(3)),
    matchedOn: scored?.matchedOn ?? null,
    matchedField: scored?.matchedField ?? null,
  });

  const usable = (Array.isArray(candidates) ? candidates : []).filter(
    (m) => m && typeof m.id === 'number' && (!m.format || ACCEPTED_FORMATS.has(m.format)),
  );

  const scored = usable
    .map((media) => ({ media, ...scoreCandidate(title, media) }))
    .sort((a, b) => b.score - a.score);

  const reported = scored.slice(0, 5).map((s) => summarise(s.media, s));

  if (scored.length === 0) {
    return { matched: false, anilistId: null, reason: 'no-candidates', media: null, candidates: reported };
  }

  const exacts = scored.filter((s) => s.exact);

  if (exacts.length === 0) {
    return {
      matched: false,
      anilistId: null,
      reason: 'no-exact-title-match',
      media: null,
      candidates: reported,
    };
  }

  // A hit on AniList's own romaji/english beats a hit on a user-contributed
  // synonym. When any candidate matched on a real title field, the
  // synonym-only candidates are not competing evidence and are dropped -
  // that alone resolves the common "recap special carries the parent series'
  // name as a synonym" collision without any confidence heuristics.
  const titleExacts = exacts.filter(isTitleFieldMatch);
  const synonymOnly = titleExacts.length === 0;

  if (synonymOnly) {
    // Nothing but synonym evidence. Demand corroboration from two independent
    // signals before trusting it, since a wrong id is worse than no id:
    //   1. the entry is a series format, not a special/OVA/movie side entry;
    //   2. its episode count is known AND can hold the numbering we scraped
    //      (an `unknown` alignment corroborates nothing).
    // Anything else is reported for a human to pin in overrides.json.
    const corroborated = exacts.filter((s) => {
      if (!SYNONYM_SERIES_FORMATS.has(s.media.format)) return false;
      const alignment = checkEpisodeAlignment(episodeCount, s.media, tolerance);
      return alignment.ok && !alignment.unknown;
    });
    if (corroborated.length !== 1) {
      return {
        matched: false,
        anilistId: null,
        reason: 'synonym-only-match',
        media: null,
        candidates: exacts.slice(0, 5).map((s) => summarise(s.media, s)),
      };
    }
    const winner = corroborated[0];
    return {
      matched: true,
      anilistId: winner.media.id,
      reason: 'exact-match',
      media: winner.media,
      matchedField: winner.matchedField,
      alignment: checkEpisodeAlignment(episodeCount, winner.media, tolerance),
      candidates: reported,
    };
  }

  let winners = titleExacts;
  if (winners.length > 1) {
    // A series and its recap/special entries often share a synonym. Prefer a
    // full TV entry; only give up if that still leaves a tie.
    const tv = winners.filter((s) => s.media.format === 'TV' || s.media.format === 'TV_SHORT');
    if (tv.length > 0) winners = tv;
  }
  if (winners.length > 1) {
    // Still tied: prefer the entry whose episode count can actually hold the
    // absolute numbering we scraped.
    const fits = winners.filter((s) => checkEpisodeAlignment(episodeCount, s.media, tolerance).ok);
    if (fits.length === 1) winners = fits;
  }

  if (winners.length > 1) {
    const ids = new Set(winners.map((s) => s.media.id));
    if (ids.size > 1) {
      return {
        matched: false,
        anilistId: null,
        reason: 'ambiguous',
        media: null,
        candidates: winners.slice(0, 5).map((s) => summarise(s.media, s)),
      };
    }
  }

  const winner = winners[0];
  const alignment = checkEpisodeAlignment(episodeCount, winner.media, tolerance);
  if (!alignment.ok) {
    return {
      matched: false,
      anilistId: null,
      reason: 'episode-count-overflow',
      media: null,
      alignment,
      candidates: reported,
    };
  }

  return {
    matched: true,
    anilistId: winner.media.id,
    reason: 'exact-match',
    media: winner.media,
    matchedField: winner.matchedField,
    alignment,
    candidates: reported,
  };
}

/**
 * Assemble the final filler.json payload.
 *
 * Keys are AniList media ids as strings, values are ascending deduped integer
 * arrays. Shows with no filler are omitted entirely rather than emitted as an
 * empty array. Two shows resolving to the same AniList id is a mapping bug, so
 * the second one is refused and reported rather than merged.
 */
export function buildFillerOutput(entries) {
  const output = {};
  const conflicts = [];
  const owner = new Map();

  for (const entry of entries) {
    const { slug, anilistId, filler } = entry;
    if (!anilistId || !Array.isArray(filler) || filler.length === 0) continue;

    const key = String(anilistId);
    if (owner.has(key)) {
      conflicts.push({ slug, anilistId, conflictsWith: owner.get(key) });
      continue;
    }
    owner.set(key, slug);
    output[key] = [...new Set(filler)].sort((a, b) => a - b);
  }

  const sorted = {};
  for (const key of Object.keys(output).sort((a, b) => Number(a) - Number(b))) {
    sorted[key] = output[key];
  }

  return { filler: sorted, conflicts };
}
