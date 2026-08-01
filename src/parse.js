/**
 * Pure parsing helpers. Nothing in this file touches the network, so every
 * function here is unit-testable against the saved fixtures in test/fixtures/.
 *
 * Site shape (verified 2026-08-01 against live HTML):
 *
 *   Index  /shows
 *     #ShowList > div.Group > ul > li > a[href^="/shows/<slug>"]
 *
 *   Show   /shows/<slug>
 *     Quick List:  #Condensed > div.<category> containing
 *                    span.Label    -> "Filler Episodes:"
 *                    span.Episodes -> "26, 97, 101-106, 136-140, 143-219"
 *     Table:       tr.<category> with td.Number, td.Title, td.Type > span, td.Date
 *
 *   The category token appears verbatim as a CSS class, and one of them
 *   ("mixed_canon/filler") contains a slash, which is not a legal CSS class
 *   selector. We therefore always read the class attribute and normalise it
 *   ourselves rather than selecting on `.mixed_canon\/filler`.
 */

import * as cheerio from 'cheerio';

/** Canonical category keys. */
export const CATEGORY = {
  MANGA_CANON: 'manga_canon',
  ANIME_CANON: 'anime_canon',
  MIXED: 'mixed_canon_filler',
  FILLER: 'filler',
};

/**
 * Which categories count as filler for the consuming app.
 *
 * The app asks a binary "is episode N filler?". The data it already ships
 * treats "Mixed Canon/Filler" as NOT filler (verified: Naruto episodes
 * 7, 9, 14-16 are Mixed and are absent from the shipped filler array), so a
 * mixed episode is canon as far as we are concerned. Only pure "Filler" counts.
 */
export const FILLER_CATEGORIES = new Set([CATEGORY.FILLER]);

/**
 * Normalise a raw category token from a class attribute or a Type cell into
 * one of the CATEGORY values. Returns null for anything unrecognised.
 *
 * Handles: "manga_canon", "mixed_canon/filler odd", "Mixed Canon/Filler",
 *          "Anime Canon", "filler even".
 */
export function normaliseCategory(raw) {
  if (!raw) return null;
  // Drop Drupal's zebra-striping classes, then fold separators together.
  const token = String(raw)
    .replace(/\b(odd|even|first|last)\b/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s/_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  switch (token) {
    case 'manga_canon':
      return CATEGORY.MANGA_CANON;
    case 'anime_canon':
      return CATEGORY.ANIME_CANON;
    case 'mixed_canon_filler':
      return CATEGORY.MIXED;
    case 'filler':
      return CATEGORY.FILLER;
    default:
      return null;
  }
}

/**
 * Expand a Quick List range string, reporting anything it could not parse.
 *
 *   "26, 97, 101-106, 136-140, 143-219"  ->  90 integers
 *   "143-219"                            ->  77 integers
 *
 * Tolerates the punctuation the site actually emits and the punctuation a
 * human editor might leave behind: en/em dashes, "to", stray whitespace,
 * trailing commas, and reversed ranges ("10-8" is read as 8-10).
 *
 * Unparseable tokens are collected into `skipped` rather than throwing, so a
 * single typo on one show cannot fail a whole run.
 *
 * @returns {{ numbers: number[], skipped: string[] }}
 */
export function expandRangesDetailed(text) {
  const skipped = [];
  const out = new Set();
  if (text == null) return { numbers: [], skipped };

  const tokens = String(text)
    .replace(/ /g, ' ')
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    // Single number.
    const single = /^(\d+)$/.exec(token);
    if (single) {
      out.add(Number(single[1]));
      continue;
    }

    // Range: 101-106, 101 – 106, 101 to 106.
    const range = /^(\d+)\s*(?:[-‐-―−~]|to)\s*(\d+)$/i.exec(token);
    if (range) {
      let lo = Number(range[1]);
      let hi = Number(range[2]);
      if (lo > hi) [lo, hi] = [hi, lo];
      // Guard against a typo like "1-99999" blowing up memory.
      if (hi - lo > 10000) {
        skipped.push(token);
        continue;
      }
      for (let n = lo; n <= hi; n++) out.add(n);
      continue;
    }

    skipped.push(token);
  }

  return { numbers: [...out].sort((a, b) => a - b), skipped };
}

/**
 * Convenience wrapper returning just the expanded numbers as a plain array.
 * Use `expandRangesDetailed` when you need to report unparseable tokens.
 */
export function expandRanges(text) {
  return expandRangesDetailed(text).numbers;
}

/**
 * Parse the /shows index into [{ slug, title }].
 *
 * Titles come from the anchor text, never from the slug: the site has at
 * least one entry whose slug belongs to an unrelated show, so a slug-derived
 * title would be wrong.
 */
export function parseShowIndex(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const shows = [];

  $('#ShowList a[href^="/shows/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = /^\/shows\/([^/?#]+)\/?$/.exec(href);
    if (!match) return; // episode links look like /shows/<slug>/<episode>
    // Slugs are percent-encoded in the markup ("sh%C5%8Dnan-..."). A malformed
    // escape must skip that one link, not throw the whole index away.
    let slug;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      slug = match[1];
    }
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!slug || !title) return;
    if (seen.has(slug)) return;
    seen.add(slug);
    shows.push({ slug, title });
  });

  return shows;
}

/**
 * Parse the "Quick List" summary block.
 * Returns { <category>: number[] } plus a `skipped` map of unparseable tokens.
 * Returns null when the block is absent entirely.
 */
export function parseQuickList(html) {
  const $ = cheerio.load(html);
  const condensed = $('#Condensed');
  if (condensed.length === 0) return null;

  const byCategory = {};
  const skipped = {};
  let sawAnyRow = false;

  condensed.children('div').each((_, el) => {
    const node = $(el);
    const category =
      normaliseCategory(node.attr('class')) ||
      // Fall back to the visible label if the class attribute is missing.
      normaliseCategory((node.find('span.Label').text() || '').replace(/episodes\s*:?\s*$/i, ''));
    if (!category) return;

    const episodesText = node.find('span.Episodes').text();
    if (!episodesText.trim()) return;

    sawAnyRow = true;
    const expanded = expandRangesDetailed(episodesText);
    const existing = byCategory[category] || [];
    byCategory[category] = [...new Set([...existing, ...expanded.numbers])].sort((a, b) => a - b);
    if (expanded.skipped.length) {
      skipped[category] = [...(skipped[category] || []), ...expanded.skipped];
    }
  });

  if (!sawAnyRow) return null;
  return { byCategory, skipped };
}

/**
 * Parse the per-episode table.
 * Returns { byCategory: { <category>: number[] }, rows: [{ number, category }] },
 * or null when there is no usable table.
 */
export function parseEpisodeTable(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('tr').each((_, el) => {
    const tr = $(el);
    const numberText = tr.find('td.Number').first().text().trim();
    if (!numberText) return;

    // A row's number is normally a plain integer. Some shows use "12-13" for a
    // double-length episode; expand so both numbers are represented.
    const numbers = expandRanges(numberText);
    if (numbers.length === 0) return;

    const category =
      normaliseCategory(tr.attr('class')) ||
      normaliseCategory(tr.find('td.Type').first().text());
    if (!category) return;

    for (const number of numbers) rows.push({ number, category });
  });

  if (rows.length === 0) return null;

  const byCategory = {};
  for (const { number, category } of rows) {
    (byCategory[category] ||= new Set()).add(number);
  }
  for (const key of Object.keys(byCategory)) {
    byCategory[key] = [...byCategory[key]].sort((a, b) => a - b);
  }

  return { byCategory, rows };
}

/** Human-readable show title from a show page ("Naruto Filler List" -> "Naruto"). */
export function parseShowTitle(html) {
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  if (!h1) return null;
  return h1.replace(/\s+filler\s+list$/i, '').trim() || null;
}

/**
 * Full parse of one show page.
 *
 * Prefers the Quick List for the filler numbers, but always cross-checks
 * against the episode table when both exist and reports disagreement instead
 * of silently trusting one source.
 *
 * @returns {{
 *   title: string|null,
 *   filler: number[],
 *   episodeCount: number,
 *   source: 'quicklist'|'table'|'none',
 *   categories: Record<string, number[]>,
 *   warnings: string[],
 *   disagreement: null|{ onlyInQuickList: number[], onlyInTable: number[] }
 * }}
 */
export function parseShowPage(html) {
  const title = parseShowTitle(html);
  const quick = parseQuickList(html);
  const table = parseEpisodeTable(html);
  const warnings = [];

  const fillerFrom = (byCategory) => {
    const out = new Set();
    for (const [category, numbers] of Object.entries(byCategory || {})) {
      if (FILLER_CATEGORIES.has(category)) for (const n of numbers) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
  };

  const quickFiller = quick ? fillerFrom(quick.byCategory) : null;
  const tableFiller = table ? fillerFrom(table.byCategory) : null;

  if (quick) {
    for (const [category, tokens] of Object.entries(quick.skipped)) {
      warnings.push(`unparseable quick-list token(s) in ${category}: ${tokens.join(', ')}`);
    }
  }
  if (!quick) warnings.push('quick list missing or empty; falling back to the episode table');
  if (!table) warnings.push('episode table missing or empty');

  let disagreement = null;
  if (quickFiller && tableFiller) {
    const tableSet = new Set(tableFiller);
    const quickSet = new Set(quickFiller);
    const onlyInQuickList = quickFiller.filter((n) => !tableSet.has(n));
    const onlyInTable = tableFiller.filter((n) => !quickSet.has(n));
    if (onlyInQuickList.length || onlyInTable.length) {
      disagreement = { onlyInQuickList, onlyInTable };
      warnings.push(
        `quick list and episode table disagree: ${onlyInQuickList.length} only in quick list, ` +
          `${onlyInTable.length} only in table`,
      );
    }
  }

  const filler = quickFiller ?? tableFiller ?? [];
  const source = quickFiller ? 'quicklist' : tableFiller ? 'table' : 'none';

  // Absolute episode count for the series, used by the AniList overflow check.
  const allNumbers = new Set();
  for (const numbers of Object.values(table?.byCategory || {})) for (const n of numbers) allNumbers.add(n);
  for (const numbers of Object.values(quick?.byCategory || {})) for (const n of numbers) allNumbers.add(n);
  const episodeCount = allNumbers.size ? Math.max(...allNumbers) : 0;

  return {
    title,
    filler,
    episodeCount,
    source,
    categories: quick?.byCategory ?? table?.byCategory ?? {},
    warnings,
    disagreement,
  };
}
